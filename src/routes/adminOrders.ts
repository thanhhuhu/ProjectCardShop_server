import { Router } from "express";
import { z } from "zod";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "../db";
import { requireAdmin } from "../middleware";
import { escapeLike } from "../utils";

// Quản lý đơn hàng (chỉ admin): xem đơn của mọi khách và đổi trạng thái
const router = Router();
router.use(requireAdmin);

const ORDER_STATUSES = ["pending", "confirmed", "shipping", "completed", "cancelled"] as const;
type OrderStatus = (typeof ORDER_STATUSES)[number];

// Trạng thái hiện tại -> các trạng thái được phép chuyển sang
const NEXT_STATUS: Record<OrderStatus, OrderStatus[]> = {
    pending: ["confirmed", "cancelled"],
    confirmed: ["shipping", "cancelled"],
    shipping: ["completed", "cancelled"],
    completed: [],
    cancelled: [],
};

interface AdminOrderRow extends RowDataPacket {
    id: number;
    code: string;
    user_id: number | null;
    username: string | null;
    full_name: string;
    phone: string;
    email: string;
    city: string;
    address: string;
    note: string;
    subtotal: number;
    shipping_fee: number;
    total_amount: number;
    payment_method: "cod" | "bank";
    payment_status: "unpaid" | "paid" | "failed";
    status: OrderStatus;
    paid_at: Date | null;
    created_at: Date;
}

interface AdminOrderItemRow extends RowDataPacket {
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

const listQuerySchema = z.object({
    page: z.coerce.number().int().min(1).catch(1),
    pageSize: z.coerce.number().int().min(1).max(50).catch(10),
    status: z.enum(ORDER_STATUSES).optional().catch(undefined),
    search: z.string().trim().max(100).optional().catch(undefined),
});

const toOrder = (row: AdminOrderRow, items: AdminOrderItemRow[]) => ({
    id: row.id,
    code: row.code,
    userId: row.user_id,
    username: row.username,
    fullName: row.full_name,
    phone: row.phone,
    email: row.email,
    city: row.city,
    address: row.address,
    note: row.note,
    subtotal: Number(row.subtotal),
    shippingFee: Number(row.shipping_fee),
    total: Number(row.total_amount),
    payment: row.payment_method,
    paymentStatus: row.payment_status,
    status: row.status,
    nextStatuses: NEXT_STATUS[row.status] ?? [],
    paidAt: row.paid_at,
    createdAt: row.created_at,
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
});

const SELECT_ORDER = `
    SELECT o.id, o.code, o.user_id, u.username, o.full_name, o.phone, o.email, o.city, o.address, o.note,
           o.subtotal, o.shipping_fee, o.total_amount, o.payment_method, o.payment_status, o.status,
           o.paid_at, o.created_at
    FROM orders o
    LEFT JOIN users u ON u.id = o.user_id`;

async function loadItems(orderIds: number[]) {
    const byOrder = new Map<number, AdminOrderItemRow[]>();
    if (orderIds.length === 0) return byOrder;

    const [items] = await pool.query<AdminOrderItemRow[]>(
        `SELECT order_id, product_id, product_code, product_name, rarity, unit_price, quantity, line_total, image_url
         FROM order_items WHERE order_id IN (?) ORDER BY id`,
        [orderIds],
    );
    for (const item of items) {
        const list = byOrder.get(item.order_id) ?? [];
        list.push(item);
        byOrder.set(item.order_id, list);
    }
    return byOrder;
}

/* ---------- Danh sách đơn hàng của mọi khách ---------- */

router.get("/", async (req, res) => {
    const { page, pageSize, status, search } = listQuerySchema.parse(req.query);

    const where: string[] = [];
    const params: unknown[] = [];

    if (status) {
        where.push("o.status = ?");
        params.push(status);
    }
    if (search) {
        // Tìm theo mã đơn, tên người nhận, số điện thoại hoặc tên tài khoản
        const like = `%${escapeLike(search)}%`;
        where.push("(o.code LIKE ? OR o.full_name LIKE ? OR o.phone LIKE ? OR u.username LIKE ?)");
        params.push(like, like, like, like);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    try {
        const [[{ total }]] = await pool.query<(RowDataPacket & { total: number })[]>(
            `SELECT COUNT(*) AS total FROM orders o LEFT JOIN users u ON u.id = o.user_id ${whereSql}`,
            params,
        );

        const [rows] = await pool.query<AdminOrderRow[]>(
            `${SELECT_ORDER} ${whereSql} ORDER BY o.created_at DESC, o.id DESC LIMIT ? OFFSET ?`,
            [...params, pageSize, (page - 1) * pageSize],
        );

        // Số đơn theo từng trạng thái (cho các tab lọc)
        const [counts] = await pool.query<(RowDataPacket & { status: OrderStatus; count: number })[]>(
            "SELECT status, COUNT(*) AS count FROM orders GROUP BY status",
        );

        const itemsByOrder = await loadItems(rows.map((row) => row.id));

        res.json({
            orders: rows.map((row) => toOrder(row, itemsByOrder.get(row.id) ?? [])),
            total: Number(total),
            page,
            pageSize,
            totalPages: Math.max(1, Math.ceil(Number(total) / pageSize)),
            statusCounts: Object.fromEntries(counts.map((c) => [c.status, Number(c.count)])),
        });
    } catch (error) {
        console.error("Lỗi lấy danh sách đơn hàng:", error);
        res.status(500).json({ message: "Không thể tải danh sách đơn hàng" });
    }
});

/* ---------- Đổi trạng thái đơn hàng ---------- */

const updateStatusSchema = z.object({
    status: z.enum(ORDER_STATUSES),
});

router.patch("/:id/status", async (req, res) => {
    const id = Number(req.params.id);
    const parsed = updateStatusSchema.safeParse(req.body);

    if (!Number.isInteger(id) || id <= 0 || !parsed.success) {
        res.status(400).json({ message: "Dữ liệu không hợp lệ" });
        return;
    }
    const nextStatus = parsed.data.status;

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        // Khóa đơn để hai admin bấm cùng lúc không làm lệch trạng thái / tồn kho
        const [rows] = await connection.query<AdminOrderRow[]>(`${SELECT_ORDER} WHERE o.id = ? FOR UPDATE`, [id]);
        const order = rows[0];

        if (!order) {
            await connection.rollback();
            res.status(404).json({ message: "Không tìm thấy đơn hàng" });
            return;
        }

        if (!NEXT_STATUS[order.status]?.includes(nextStatus)) {
            await connection.rollback();
            res.status(409).json({ message: "Không thể chuyển đơn sang trạng thái này (có thể đơn vừa được người khác cập nhật)" });
            return;
        }

        if (nextStatus === "cancelled") {
            // Hủy đơn: trả lại hàng vào kho
            await connection.query(
                `UPDATE products p
                 JOIN order_items oi ON oi.product_id = p.id
                 SET p.stock = p.stock + oi.quantity
                 WHERE oi.order_id = ?`,
                [id],
            );
        }

        if (nextStatus === "completed" && order.payment_method === "cod" && order.payment_status !== "paid") {
            // Đơn COD giao xong nghĩa là đã thu tiền mặt
            await connection.execute(
                "UPDATE orders SET status = ?, payment_status = 'paid', paid_at = NOW() WHERE id = ?",
                [nextStatus, id],
            );
        } else {
            await connection.execute<ResultSetHeader>("UPDATE orders SET status = ? WHERE id = ?", [nextStatus, id]);
        }

        await connection.commit();

        const [updated] = await pool.query<AdminOrderRow[]>(`${SELECT_ORDER} WHERE o.id = ?`, [id]);
        const itemsByOrder = await loadItems([id]);
        res.json({ order: toOrder(updated[0], itemsByOrder.get(id) ?? []) });
    } catch (error) {
        await connection?.rollback().catch(() => undefined);
        console.error("Lỗi cập nhật trạng thái đơn hàng:", error);
        res.status(500).json({ message: "Không thể cập nhật đơn hàng" });
    } finally {
        connection?.release();
    }
});

export default router;
