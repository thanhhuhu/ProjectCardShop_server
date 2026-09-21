import { Router } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "../db";
import { getUserId } from "../auth";

const router = Router();

const FREE_SHIPPING_THRESHOLD = 150_000;
const SHIPPING_FEE = 30_000;

const BANK_NAME = process.env.BANK_NAME?.trim() ?? "";
const BANK_ACCOUNT_NUMBER = process.env.BANK_ACCOUNT_NUMBER?.trim() ?? "";
const BANK_ACCOUNT_NAME = process.env.BANK_ACCOUNT_NAME?.trim() ?? "";
const SEPAY_WEBHOOK_API_KEY = process.env.SEPAY_WEBHOOK_API_KEY?.trim() ?? "";

const orderItemSchema = z.object({
    productId: z.number().int().positive(),
    code: z.string().trim().min(1).max(100),
    name: z.string().trim().min(1).max(255),
    rarity: z.string().trim().max(100).default(""),
    price: z.number().int().nonnegative(),
    quantity: z.number().int().min(1).max(99),
    imageUrl: z.string().trim().max(1000).default(""),
});

const createOrderSchema = z.object({
    fullName: z.string().trim().min(2).max(120),
    phone: z.string().trim().min(8).max(30),
    email: z.string().trim().max(255).optional().default(""),
    city: z.string().trim().min(1).max(120),
    address: z.string().trim().min(5).max(255),
    note: z.string().trim().max(1000).optional().default(""),
    paymentMethod: z.enum(["cod", "bank"]),
    items: z.array(orderItemSchema).min(1).max(50),
});

interface OrderRow extends RowDataPacket {
    id: number;
    code: string;
    total_amount: number;
    payment_method: "cod" | "bank";
    payment_status: "unpaid" | "paid" | "failed";
    status: "pending" | "confirmed" | "shipping" | "completed" | "cancelled";
    paid_at: Date | null;
    created_at: Date;
}

function createOrderCode(): string {
    // Mã khó đoán, dùng luôn làm nội dung chuyển khoản.
    return `CS${randomBytes(7).toString("hex").toUpperCase()}`;
}

function buildQrUrl(code: string, amount: number): string | null {
    if (!BANK_NAME || !BANK_ACCOUNT_NUMBER) return null;

    const params = new URLSearchParams({
        amount: String(amount),
        addInfo: code,
    });

    if (BANK_ACCOUNT_NAME) params.set("accountName", BANK_ACCOUNT_NAME);

    return `https://img.vietqr.io/image/${encodeURIComponent(BANK_NAME)}-${encodeURIComponent(BANK_ACCOUNT_NUMBER)}-compact2.png?${params.toString()}`;
}

function buildPaymentInfo(code: string, amount: number) {
    const qrUrl = buildQrUrl(code, amount);

    return {
        bankName: BANK_NAME || null,
        accountNumber: BANK_ACCOUNT_NUMBER || null,
        accountName: BANK_ACCOUNT_NAME || null,
        transferContent: code,
        qrUrl,
    };
}

/* ---------- Tạo đơn hàng ---------- */

router.post("/", async (req, res) => {
    const parsed = createOrderSchema.safeParse(req.body);

    if (!parsed.success) {
        res.status(400).json({ message: "Dữ liệu đơn hàng không hợp lệ" });
        return;
    }

    const data = parsed.data;

    if (data.paymentMethod === "bank" && (!BANK_NAME || !BANK_ACCOUNT_NUMBER)) {
        res.status(503).json({
            message: "Thanh toán QR chưa được cấu hình. Hãy thêm BANK_NAME và BANK_ACCOUNT_NUMBER vào .env của server.",
        });
        return;
    }

    // Backend tự tính lại tiền từ các dòng hàng nhận được, không dùng subtotal/total do frontend gửi.
    const subtotal = data.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const shippingFee = subtotal === 0 || subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_FEE;
    const total = subtotal + shippingFee;
    const paymentStatus = "unpaid";
    const status = "pending";
    const code = createOrderCode();
    const userId = getUserId(req);

    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        const [orderResult] = await connection.execute<ResultSetHeader>(
            `INSERT INTO orders
                (code, user_id, full_name, phone, email, city, address, note,
                 subtotal, shipping_fee, total_amount, payment_method, payment_status, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                code,
                userId,
                data.fullName,
                data.phone,
                data.email,
                data.city,
                data.address,
                data.note,
                subtotal,
                shippingFee,
                total,
                data.paymentMethod,
                paymentStatus,
                status,
            ],
        );

        const orderId = orderResult.insertId;

        for (const item of data.items) {
            await connection.execute(
                `INSERT INTO order_items
                    (order_id, product_id, product_code, product_name, rarity, unit_price, quantity, line_total, image_url)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    orderId,
                    item.productId,
                    item.code,
                    item.name,
                    item.rarity,
                    item.price,
                    item.quantity,
                    item.price * item.quantity,
                    item.imageUrl,
                ],
            );
        }

        await connection.commit();

        res.status(201).json({
            order: {
                id: orderId,
                code,
                subtotal,
                shippingFee,
                total,
                payment: data.paymentMethod,
                paymentStatus,
                status,
                ...buildPaymentInfo(code, total),
            },
        });
    } catch (error) {
        await connection.rollback();
        console.error("Lỗi tạo đơn hàng:", error);
        res.status(500).json({ message: "Không thể tạo đơn hàng. Vui lòng thử lại." });
    } finally {
        connection.release();
    }
});

/* ---------- Kiểm tra trạng thái thanh toán ---------- */

router.get("/:code/status", async (req, res) => {
    const code = String(req.params.code ?? "").trim().toUpperCase();

    if (!/^CS[A-F0-9]{14}$/.test(code)) {
        res.status(400).json({ message: "Mã đơn hàng không hợp lệ" });
        return;
    }

    try {
        const [rows] = await pool.execute<OrderRow[]>(
            `SELECT id, code, total_amount, payment_method, payment_status, status, paid_at, created_at
             FROM orders
             WHERE code = ?
             LIMIT 1`,
            [code],
        );

        const order = rows[0];
        if (!order) {
            res.status(404).json({ message: "Không tìm thấy đơn hàng" });
            return;
        }

        res.json({
            code: order.code,
            status: order.payment_status === "paid" ? "paid" : order.payment_status,
            paymentStatus: order.payment_status,
            orderStatus: order.status,
            total: order.total_amount,
            paidAt: order.paid_at,
        });
    } catch (error) {
        console.error("Lỗi kiểm tra trạng thái đơn hàng:", error);
        res.status(500).json({ message: "Không thể kiểm tra trạng thái đơn hàng" });
    }
});

/* ---------- Webhook SePay: tự xác nhận khi tiền vào ---------- */

router.post("/webhook/sepay", async (req, res) => {
    if (!SEPAY_WEBHOOK_API_KEY) {
        res.status(503).json({ message: "SEPAY_WEBHOOK_API_KEY chưa được cấu hình" });
        return;
    }

    const authorization = String(req.get("authorization") ?? "");
    const expected = `Apikey ${SEPAY_WEBHOOK_API_KEY}`;

    if (authorization !== expected) {
        res.status(401).json({ success: false });
        return;
    }

    const body = req.body as Record<string, unknown>;
    const transactionId = String(body.id ?? "").trim();
    const transferType = String(body.transferType ?? "").trim().toLowerCase();
    const transferAmount = Number(body.transferAmount ?? 0);
    const accountNumber = String(body.accountNumber ?? "").trim();
    const codeField = String(body.code ?? "").trim().toUpperCase();
    const content = String(body.content ?? "").trim();

    if (!transactionId || transferType !== "in" || !Number.isFinite(transferAmount) || transferAmount <= 0) {
        res.status(400).json({ success: false, message: "Payload giao dịch không hợp lệ" });
        return;
    }

    if (BANK_ACCOUNT_NUMBER && accountNumber && accountNumber !== BANK_ACCOUNT_NUMBER) {
        res.status(200).json({ success: true, ignored: true });
        return;
    }

    // Order code của shop có dạng CS + 14 ký tự HEX.
    const matchInContent = content.match(/\b(CS[A-F0-9]{14})\b/i)?.[1]?.toUpperCase() ?? "";
    const orderCode = /^CS[A-F0-9]{14}$/.test(codeField) ? codeField : matchInContent;

    if (!orderCode) {
        res.status(200).json({ success: true, ignored: true });
        return;
    }

    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        const [orders] = await connection.execute<OrderRow[]>(
            `SELECT id, code, total_amount, payment_method, payment_status, status, paid_at, created_at
             FROM orders
             WHERE code = ?
             LIMIT 1
             FOR UPDATE`,
            [orderCode],
        );

        const order = orders[0];
        if (!order || order.payment_method !== "bank") {
            await connection.rollback();
            res.status(200).json({ success: true, ignored: true });
            return;
        }

        const [transactionResult] = await connection.execute<ResultSetHeader>(
            `INSERT IGNORE INTO payment_transactions
                (provider, transaction_id, order_id, amount, account_number, content, raw_payload)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                "sepay",
                transactionId,
                order.id,
                Math.trunc(transferAmount),
                accountNumber,
                content,
                JSON.stringify(body),
            ],
        );

        // Webhook có thể được SePay gửi lại. Giao dịch đã tồn tại thì coi như đã xử lý.
        if (transactionResult.affectedRows === 0) {
            await connection.commit();
            res.status(200).json({ success: true, duplicate: true });
            return;
        }

        if (order.payment_status === "unpaid" && order.total_amount <= Math.trunc(transferAmount)) {
            await connection.execute(
                `UPDATE orders
                 SET payment_status = 'paid', paid_at = NOW()
                 WHERE id = ? AND payment_status = 'unpaid' AND total_amount <= ?`,
                [order.id, Math.trunc(transferAmount)],
            );
        }

        await connection.commit();
        res.status(200).json({ success: true });
    } catch (error) {
        await connection.rollback();
        console.error("Lỗi webhook SePay:", error);
        res.status(500).json({ success: false });
    } finally {
        connection.release();
    }
});

export default router;
