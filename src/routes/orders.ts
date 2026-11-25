import { Router } from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "../db";
import { getUserId } from "../auth";
import { collectErrors } from "../utils";
import { validateDiscount } from "./discounts";

const router = Router();

const FREE_SHIPPING_THRESHOLD = 150_000;
const SHIPPING_FEE = 30_000;

const BANK_NAME = process.env.BANK_NAME?.trim() ?? "";
const BANK_ACCOUNT_NUMBER = process.env.BANK_ACCOUNT_NUMBER?.trim() ?? "";
const BANK_ACCOUNT_NAME = process.env.BANK_ACCOUNT_NAME?.trim() ?? "";
const SEPAY_WEBHOOK_API_KEY = process.env.SEPAY_WEBHOOK_API_KEY?.trim() ?? "";
const N8N_ORDER_WEBHOOK_URL = process.env.N8N_ORDER_WEBHOOK_URL?.trim() ?? "";

// Gửi thông báo đơn mới sang n8n (để n8n bắn về Telegram, v.v.).
// Fire-and-forget: không chờ, không để lỗi làm hỏng việc tạo đơn.
function notifyNewOrder(payload: Record<string, unknown>): void {
    if (!N8N_ORDER_WEBHOOK_URL) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    fetch(N8N_ORDER_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
    })
        .catch(() => undefined)
        .finally(() => clearTimeout(timer));
}

// Chỉ nhận id sản phẩm và số lượng. Tên, mã, giá, ảnh... luôn đọc lại từ database,
// không tin dữ liệu frontend gửi lên (các trường thừa như price sẽ bị zod bỏ qua).
const MAX_QUANTITY_PER_PRODUCT = 99;

const orderItemSchema = z.object({
    productId: z.number().int().positive(),
    quantity: z.number().int().min(1).max(MAX_QUANTITY_PER_PRODUCT),
});

const createOrderSchema = z.object({
    fullName: z.string().trim().min(2, "Họ tên cần ít nhất 2 ký tự").max(120),
    phone: z.string().trim().min(8, "Số điện thoại không hợp lệ").max(30),
    email: z
        .string()
        .trim()
        .toLowerCase()
        .max(255)
        .email("Địa chỉ email không hợp lệ")
        .or(z.literal(""))
        .optional()
        .default(""),
    city: z.string().trim().min(1).max(120),
    address: z.string().trim().min(5).max(255),
    note: z.string().trim().max(1000).optional().default(""),
    paymentMethod: z.enum(["cod", "bank"]),
    discountCode: z.string().trim().max(40).optional().default(""),
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

interface ProductRow extends RowDataPacket {
    id: number;
    code: string;
    name: string;
    rarity: string;
    price: number;
    stock: number;
    image_url: string;
}

// Lỗi do dữ liệu người dùng (sản phẩm không tồn tại, hết hàng...), trả về đúng mã HTTP thay vì 500
class OrderError extends Error {
    constructor(
        public status: number,
        message: string,
    ) {
        super(message);
    }
}

// So sánh chuỗi bí mật với thời gian không đổi để không lộ API key qua thời gian phản hồi
function safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
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
        res.status(400).json({ message: "Dữ liệu đơn hàng không hợp lệ", errors: collectErrors(parsed.error) });
        return;
    }

    const data = parsed.data;

    if (data.paymentMethod === "bank" && (!BANK_NAME || !BANK_ACCOUNT_NUMBER)) {
        res.status(503).json({
            message: "Thanh toán QR chưa được cấu hình. Hãy thêm BANK_NAME và BANK_ACCOUNT_NUMBER vào .env của server.",
        });
        return;
    }

    // Gộp các dòng trùng sản phẩm thành một dòng
    const quantities = new Map<number, number>();
    for (const item of data.items) {
        quantities.set(item.productId, (quantities.get(item.productId) ?? 0) + item.quantity);
    }
    for (const quantity of quantities.values()) {
        if (quantity > MAX_QUANTITY_PER_PRODUCT) {
            res.status(400).json({ message: `Mỗi sản phẩm chỉ đặt tối đa ${MAX_QUANTITY_PER_PRODUCT} cái` });
            return;
        }
    }

    const paymentStatus = "unpaid";
    const status = "pending";
    const code = createOrderCode();
    const userId = getUserId(req);

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        // Đọc giá + tồn kho từ database và khóa các dòng này cho tới khi commit,
        // để hai người đặt cùng lúc không mua quá số lượng còn lại.
        const ids = [...quantities.keys()];
        const [products] = await connection.query<ProductRow[]>(
            "SELECT id, code, name, rarity, price, stock, image_url FROM products WHERE id IN (?) FOR UPDATE",
            [ids],
        );
        const productById = new Map(products.map((p) => [Number(p.id), p]));

        const lines = ids.map((productId) => {
            const product = productById.get(productId);
            const quantity = quantities.get(productId)!;
            if (!product) throw new OrderError(400, `Sản phẩm #${productId} không còn tồn tại`);
            if (product.stock < quantity) {
                throw new OrderError(409, `"${product.name}" chỉ còn ${product.stock} sản phẩm`);
            }
            return { product, quantity, lineTotal: Number(product.price) * quantity };
        });

        // Tiền luôn tính từ giá trong database
        const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);

        // Mã giảm giá: kiểm tra lại ở server (không tin số frontend gửi), khóa dòng mã trong transaction
        let discountCode = "";
        let discountAmount = 0;
        if (data.discountCode) {
            const result = await validateDiscount(connection, data.discountCode, subtotal, true);
            if (!result.ok) throw new OrderError(400, result.message);
            discountCode = result.discount!.code;
            discountAmount = result.discount!.amount;
        }

        const shippingFee = subtotal === 0 || subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_FEE;
        const total = subtotal - discountAmount + shippingFee;

        const [orderResult] = await connection.execute<ResultSetHeader>(
            `INSERT INTO orders
                (code, user_id, full_name, phone, email, city, address, note,
                 subtotal, shipping_fee, total_amount, discount_code, discount_amount, payment_method, payment_status, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
                discountCode,
                discountAmount,
                data.paymentMethod,
                paymentStatus,
                status,
            ],
        );

        const orderId = orderResult.insertId;

        // Tăng lượt dùng của mã (chỉ khi đơn tạo thành công)
        if (discountCode) {
            await connection.execute("UPDATE discount_codes SET used_count = used_count + 1 WHERE code = ?", [discountCode]);
        }

        for (const { product, quantity, lineTotal } of lines) {
            await connection.execute(
                `INSERT INTO order_items
                    (order_id, product_id, product_code, product_name, rarity, unit_price, quantity, line_total, image_url)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [orderId, product.id, product.code, product.name, product.rarity, product.price, quantity, lineTotal, product.image_url],
            );
            await connection.execute("UPDATE products SET stock = stock - ? WHERE id = ?", [quantity, product.id]);
        }

        await connection.commit();

        // Báo đơn mới sang n8n (không chặn phản hồi cho khách)
        notifyNewOrder({
            event: "order.created",
            code,
            customerName: data.fullName,
            phone: data.phone,
            city: data.city,
            address: data.address,
            note: data.note ?? "",
            paymentMethod: data.paymentMethod, // "cod" | "bank"
            subtotal,
            discountCode,
            discountAmount,
            shippingFee,
            totalAmount: total,
            itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
            items: lines.map((line) => ({
                name: line.product.name,
                rarity: line.product.rarity,
                quantity: line.quantity,
                lineTotal: line.lineTotal,
            })),
            createdAt: new Date().toISOString(),
        });

        res.status(201).json({
            order: {
                id: orderId,
                code,
                subtotal,
                discountCode,
                discountAmount,
                shippingFee,
                total,
                payment: data.paymentMethod,
                paymentStatus,
                status,
                ...buildPaymentInfo(code, total),
            },
        });
    } catch (error) {
        await connection?.rollback().catch(() => undefined);

        if (error instanceof OrderError) {
            res.status(error.status).json({ message: error.message });
            return;
        }

        console.error("Lỗi tạo đơn hàng:", error);
        res.status(500).json({ message: "Không thể tạo đơn hàng. Vui lòng thử lại." });
    } finally {
        connection?.release();
    }
});

/* ---------- Lịch sử đặt hàng của người dùng đang đăng nhập ---------- */

interface MyOrderRow extends RowDataPacket {
    id: number;
    code: string;
    full_name: string;
    phone: string;
    city: string;
    address: string;
    note: string;
    subtotal: number;
    shipping_fee: number;
    total_amount: number;
    payment_method: "cod" | "bank";
    payment_status: "unpaid" | "paid" | "failed";
    status: string;
    paid_at: Date | null;
    created_at: Date;
}

interface MyOrderItemRow extends RowDataPacket {
    order_id: number;
    product_id: number | null;
    product_code: string;
    product_name: string;
    rarity: string;
    unit_price: number;
    quantity: number;
    line_total: number;
    image_url: string;
}

const myOrdersQuerySchema = z.object({
    page: z.coerce.number().int().min(1).catch(1),
    pageSize: z.coerce.number().int().min(1).max(50).catch(10),
});

router.get("/mine", async (req, res) => {
    const userId = getUserId(req);
    if (!userId) {
        res.status(401).json({ message: "Bạn cần đăng nhập để xem lịch sử đặt hàng" });
        return;
    }

    const { page, pageSize } = myOrdersQuerySchema.parse(req.query);

    try {
        const [[{ total }]] = await pool.query<(RowDataPacket & { total: number })[]>(
            "SELECT COUNT(*) AS total FROM orders WHERE user_id = ?",
            [userId],
        );

        const [orders] = await pool.query<MyOrderRow[]>(
            `SELECT id, code, full_name, phone, city, address, note, subtotal, shipping_fee, total_amount,
                    discount_code, discount_amount, payment_method, payment_status, status, paid_at, created_at
             FROM orders
             WHERE user_id = ?
             ORDER BY created_at DESC, id DESC
             LIMIT ? OFFSET ?`,
            [userId, pageSize, (page - 1) * pageSize],
        );

        const itemsByOrder = new Map<number, MyOrderItemRow[]>();
        if (orders.length > 0) {
            const [items] = await pool.query<MyOrderItemRow[]>(
                `SELECT order_id, product_id, product_code, product_name, rarity, unit_price, quantity, line_total, image_url
                 FROM order_items
                 WHERE order_id IN (?)
                 ORDER BY id`,
                [orders.map((order) => order.id)],
            );
            for (const item of items) {
                const list = itemsByOrder.get(item.order_id) ?? [];
                list.push(item);
                itemsByOrder.set(item.order_id, list);
            }
        }

        res.json({
            orders: orders.map((order) => {
                const total = Number(order.total_amount);
                // Đơn chuyển khoản chưa trả tiền: gửi kèm thông tin để người dùng quét QR lại
                const awaitingTransfer =
                    order.payment_method === "bank" && order.payment_status === "unpaid" && order.status !== "cancelled";

                return {
                    id: order.id,
                    code: order.code,
                    fullName: order.full_name,
                    phone: order.phone,
                    city: order.city,
                    address: order.address,
                    note: order.note,
                    subtotal: Number(order.subtotal),
                    shippingFee: Number(order.shipping_fee),
                    discountCode: order.discount_code,
                    discountAmount: Number(order.discount_amount),
                    total,
                    payment: order.payment_method,
                    paymentStatus: order.payment_status,
                    status: order.status,
                    paidAt: order.paid_at,
                    createdAt: order.created_at,
                    paymentInfo: awaitingTransfer ? buildPaymentInfo(order.code, total) : null,
                    items: (itemsByOrder.get(order.id) ?? []).map((item) => ({
                        productId: item.product_id,
                        code: item.product_code,
                        name: item.product_name,
                        rarity: item.rarity,
                        price: Number(item.unit_price),
                        quantity: item.quantity,
                        lineTotal: Number(item.line_total),
                        imageUrl: item.image_url,
                    })),
                };
            }),
            total: Number(total),
            page,
            pageSize,
            totalPages: Math.max(1, Math.ceil(Number(total) / pageSize)),
        });
    } catch (error) {
        console.error("Lỗi lấy lịch sử đặt hàng:", error);
        res.status(500).json({ message: "Không thể tải lịch sử đặt hàng" });
    }
});

/* ---------- Tra cứu đơn cho khách vãng lai (mã đơn + số điện thoại) ---------- */

const lookupSchema = z.object({
    code: z.string().trim().min(3).max(40),
    phone: z.string().trim().min(4).max(30),
});

router.post("/lookup", async (req, res) => {
    const parsed = lookupSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ message: "Vui lòng nhập mã đơn và số điện thoại" });
        return;
    }
    const code = parsed.data.code.toUpperCase();
    const phone = parsed.data.phone.replace(/[\s.-]/g, "");

    const [orders] = await pool.query<(RowDataPacket & MyOrderRow)[]>(
        `SELECT id, code, full_name, phone, city, address, note, subtotal, shipping_fee, total_amount,
                discount_code, discount_amount, payment_method, payment_status, status, paid_at, created_at
         FROM orders WHERE code = ? LIMIT 1`,
        [code],
    );
    const order = orders[0];
    // So khớp số điện thoại (bỏ khoảng trắng) để người lạ không tra bừa bằng mỗi mã đơn
    if (!order || order.phone.replace(/[\s.-]/g, "") !== phone) {
        res.status(404).json({ message: "Không tìm thấy đơn khớp mã và số điện thoại" });
        return;
    }

    const [items] = await pool.query<MyOrderItemRow[]>(
        `SELECT product_id, product_code, product_name, rarity, unit_price, quantity, line_total, image_url
         FROM order_items WHERE order_id = ? ORDER BY id`,
        [order.id],
    );

    const total = Number(order.total_amount);
    const awaitingTransfer = order.payment_method === "bank" && order.payment_status === "unpaid" && order.status !== "cancelled";
    res.json({
        order: {
            code: order.code,
            fullName: order.full_name,
            phone: order.phone,
            city: order.city,
            address: order.address,
            note: order.note,
            subtotal: Number(order.subtotal),
            shippingFee: Number(order.shipping_fee),
            discountCode: order.discount_code,
            discountAmount: Number(order.discount_amount),
            total,
            payment: order.payment_method,
            paymentStatus: order.payment_status,
            status: order.status,
            paidAt: order.paid_at,
            createdAt: order.created_at,
            paymentInfo: awaitingTransfer ? buildPaymentInfo(order.code, total) : null,
            items: items.map((item) => ({
                productId: item.product_id,
                code: item.product_code,
                name: item.product_name,
                rarity: item.rarity,
                price: Number(item.unit_price),
                quantity: item.quantity,
                lineTotal: Number(item.line_total),
                imageUrl: item.image_url,
            })),
        },
    });
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

    if (!safeEqual(authorization, expected)) {
        res.status(401).json({ success: false });
        return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
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

    let connection;
    try {
        connection = await pool.getConnection();
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
        await connection?.rollback().catch(() => undefined);
        console.error("Lỗi webhook SePay:", error);
        res.status(500).json({ success: false });
    } finally {
        connection?.release();
    }
});

export default router;
