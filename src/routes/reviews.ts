import { Router } from "express";
import { z } from "zod";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "../db";
import { requireAdmin, requireAuth } from "../middleware";
import type { CurrentUser } from "../middleware";
import { collectErrors } from "../utils";

const router = Router();

interface ReviewRow extends RowDataPacket {
    id: number;
    product_id: number;
    user_id: number;
    username: string;
    product_name: string;
    rating: number;
    comment: string;
    status: "pending" | "approved" | "rejected";
    created_at: Date;
}

const toReview = (r: ReviewRow) => ({
    id: r.id,
    productId: r.product_id,
    user: r.username,
    productName: r.product_name,
    rating: r.rating,
    comment: r.comment,
    status: r.status,
    createdAt: r.created_at,
});

/* ---------- Đánh giá đã duyệt của một sản phẩm (công khai) ---------- */

router.get("/", async (req, res) => {
    const productId = Number(req.query.productId);
    if (!Number.isInteger(productId) || productId <= 0) {
        res.status(400).json({ message: "Thiếu productId" });
        return;
    }
    const [reviews] = await pool.query<ReviewRow[]>(
        `SELECT r.id, r.product_id, r.user_id, u.username, r.rating, r.comment, r.status, r.created_at
         FROM product_reviews r JOIN users u ON u.id = r.user_id
         WHERE r.product_id = ? AND r.status = 'approved'
         ORDER BY r.created_at DESC`,
        [productId],
    );
    const count = reviews.length;
    const average = count ? Math.round((reviews.reduce((s, r) => s + r.rating, 0) / count) * 10) / 10 : 0;
    res.json({ average, count, reviews: reviews.map(toReview) });
});

/* ---------- Đánh giá của chính mình (để biết đã gửi / đang chờ duyệt) ---------- */

router.get("/mine", requireAuth, async (req, res) => {
    const me = res.locals.user as CurrentUser;
    const productId = Number(req.query.productId);
    if (!Number.isInteger(productId)) {
        res.json({ review: null });
        return;
    }
    const [rows] = await pool.query<ReviewRow[]>(
        `SELECT r.id, r.product_id, r.user_id, u.username, r.rating, r.comment, r.status, r.created_at
         FROM product_reviews r JOIN users u ON u.id = r.user_id
         WHERE r.product_id = ? AND r.user_id = ?`,
        [productId, me.id],
    );
    res.json({ review: rows[0] ? toReview(rows[0]) : null });
});

/* ---------- Gửi / cập nhật đánh giá (phải đăng nhập, chờ admin duyệt) ---------- */

const reviewSchema = z.object({
    productId: z.coerce.number().int().positive(),
    rating: z.coerce.number().int().min(1, "Chọn từ 1 đến 5 sao").max(5),
    comment: z.string().trim().max(2000).default(""),
});

router.post("/", requireAuth, async (req, res) => {
    const parsed = reviewSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ message: "Dữ liệu không hợp lệ", errors: collectErrors(parsed.error) });
        return;
    }
    const me = res.locals.user as CurrentUser;
    const { productId, rating, comment } = parsed.data;

    // Mỗi người 1 đánh giá / 1 thẻ; gửi lại thì cập nhật và quay về trạng thái chờ duyệt
    await pool.execute(
        `INSERT INTO product_reviews (product_id, user_id, rating, comment, status)
         VALUES (?, ?, ?, ?, 'pending')
         ON DUPLICATE KEY UPDATE rating = VALUES(rating), comment = VALUES(comment), status = 'pending'`,
        [productId, me.id, rating, comment],
    );
    res.status(201).json({ ok: true, message: "Cảm ơn bạn! Đánh giá sẽ hiển thị sau khi được duyệt." });
});

/* ---------- Admin duyệt đánh giá ---------- */

router.get("/admin", requireAdmin, async (req, res) => {
    const status = z.enum(["pending", "approved", "rejected"]).optional().catch(undefined).parse(req.query.status);
    const where = status ? "WHERE r.status = ?" : "";
    const params = status ? [status] : [];
    const [rows] = await pool.query<ReviewRow[]>(
        `SELECT r.id, r.product_id, r.user_id, u.username, p.name AS product_name, r.rating, r.comment, r.status, r.created_at
         FROM product_reviews r JOIN users u ON u.id = r.user_id JOIN products p ON p.id = r.product_id
         ${where} ORDER BY r.created_at DESC`,
        params,
    );
    res.json({ reviews: rows.map(toReview) });
});

router.patch("/admin/:id", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const parsed = z.object({ status: z.enum(["approved", "rejected", "pending"]) }).safeParse(req.body);
    if (!Number.isInteger(id) || !parsed.success) {
        res.status(400).json({ message: "Dữ liệu không hợp lệ" });
        return;
    }
    const [result] = await pool.execute<ResultSetHeader>("UPDATE product_reviews SET status = ? WHERE id = ?", [
        parsed.data.status,
        id,
    ]);
    if (result.affectedRows === 0) {
        res.status(404).json({ message: "Không tìm thấy đánh giá" });
        return;
    }
    res.json({ ok: true });
});

router.delete("/admin/:id", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    await pool.execute("DELETE FROM product_reviews WHERE id = ?", [Number.isInteger(id) ? id : 0]);
    res.status(204).end();
});

export default router;
