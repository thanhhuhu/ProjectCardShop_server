import { Router } from "express";
import { z } from "zod";
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../db";
import { requireAdmin } from "../middleware";
import { collectErrors } from "../utils";

export interface DiscountRow extends RowDataPacket {
    id: number;
    code: string;
    discount_type: "percent" | "amount";
    value: number;
    min_order: number;
    max_uses: number | null;
    used_count: number;
    active: number;
    expires_at: Date | null;
    created_at: Date;
}

export interface DiscountResult {
    ok: boolean;
    message: string;
    discount?: { id: number; code: string; amount: number };
}

// Kiểm tra mã và tính số tiền được giảm. Dùng chung cho endpoint xem thử và lúc đặt hàng.
// Truyền connection (trong transaction) để khóa dòng mã khi đặt hàng thật.
export async function validateDiscount(
    db: Pool | PoolConnection,
    rawCode: string,
    subtotal: number,
    lock = false,
): Promise<DiscountResult & { row?: DiscountRow }> {
    const code = rawCode.trim().toUpperCase();
    if (!code) return { ok: false, message: "Chưa nhập mã giảm giá" };

    const [rows] = await db.query<DiscountRow[]>(
        `SELECT * FROM discount_codes WHERE code = ?${lock ? " FOR UPDATE" : ""}`,
        [code],
    );
    const row = rows[0];
    if (!row || !row.active) return { ok: false, message: "Mã giảm giá không tồn tại hoặc đã tắt" };
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
        return { ok: false, message: "Mã giảm giá đã hết hạn" };
    }
    if (row.max_uses !== null && row.used_count >= row.max_uses) {
        return { ok: false, message: "Mã giảm giá đã hết lượt sử dụng" };
    }
    if (subtotal < row.min_order) {
        return { ok: false, message: `Đơn tối thiểu ${row.min_order.toLocaleString("vi-VN")}đ để dùng mã này` };
    }

    const raw = row.discount_type === "percent" ? Math.floor((subtotal * row.value) / 100) : row.value;
    const amount = Math.min(raw, subtotal); // không giảm quá giá trị hàng
    return { ok: true, message: "Áp dụng mã thành công", discount: { id: row.id, code: row.code, amount }, row };
}

const router = Router();

/* ---------- Khách xem thử mã ở trang thanh toán ---------- */

const validateSchema = z.object({
    code: z.string().trim().max(40),
    subtotal: z.coerce.number().int().min(0),
});

router.post("/validate", async (req, res) => {
    const parsed = validateSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ ok: false, message: "Dữ liệu không hợp lệ" });
        return;
    }
    const result = await validateDiscount(pool, parsed.data.code, parsed.data.subtotal);
    res.json({ ok: result.ok, message: result.message, discount: result.discount ?? null });
});

/* ---------- Admin quản lý mã ---------- */

const toDiscount = (r: DiscountRow) => ({
    id: r.id,
    code: r.code,
    type: r.discount_type,
    value: r.value,
    minOrder: r.min_order,
    maxUses: r.max_uses,
    usedCount: r.used_count,
    active: Boolean(r.active),
    expiresAt: r.expires_at,
    createdAt: r.created_at,
});

router.get("/admin", requireAdmin, async (_req, res) => {
    const [rows] = await pool.query<DiscountRow[]>("SELECT * FROM discount_codes ORDER BY created_at DESC, id DESC");
    res.json({ discounts: rows.map(toDiscount) });
});

const upsertSchema = z.object({
    code: z.string().trim().min(2, "Mã cần ít nhất 2 ký tự").max(40).toUpperCase(),
    type: z.enum(["percent", "amount"]),
    value: z.coerce.number().int().positive("Giá trị phải lớn hơn 0"),
    minOrder: z.coerce.number().int().min(0).default(0),
    maxUses: z.coerce.number().int().positive().nullable().default(null),
    active: z.boolean().default(true),
    expiresAt: z.string().datetime().nullable().optional().default(null),
}).refine((d) => d.type !== "percent" || d.value <= 100, {
    message: "Phần trăm giảm tối đa 100",
    path: ["value"],
});

router.post("/admin", requireAdmin, async (req, res) => {
    const parsed = upsertSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ message: "Dữ liệu không hợp lệ", errors: collectErrors(parsed.error) });
        return;
    }
    const d = parsed.data;
    try {
        const [result] = await pool.execute<ResultSetHeader>(
            `INSERT INTO discount_codes (code, discount_type, value, min_order, max_uses, active, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [d.code, d.type, d.value, d.minOrder, d.maxUses, d.active ? 1 : 0, d.expiresAt ? new Date(d.expiresAt) : null],
        );
        const [rows] = await pool.query<DiscountRow[]>("SELECT * FROM discount_codes WHERE id = ?", [result.insertId]);
        res.status(201).json({ discount: toDiscount(rows[0]) });
    } catch (error) {
        if ((error as { code?: string }).code === "ER_DUP_ENTRY") {
            res.status(409).json({ message: "Mã này đã tồn tại", errors: { code: "Mã này đã tồn tại" } });
            return;
        }
        console.error("Lỗi tạo mã giảm giá:", error);
        res.status(500).json({ message: "Không thể tạo mã giảm giá" });
    }
});

router.patch("/admin/:id", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const active = z.object({ active: z.boolean() }).safeParse(req.body);
    if (!Number.isInteger(id) || !active.success) {
        res.status(400).json({ message: "Dữ liệu không hợp lệ" });
        return;
    }
    await pool.execute("UPDATE discount_codes SET active = ? WHERE id = ?", [active.data.active ? 1 : 0, id]);
    res.json({ ok: true });
});

router.delete("/admin/:id", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    await pool.execute("DELETE FROM discount_codes WHERE id = ?", [Number.isInteger(id) ? id : 0]);
    res.status(204).end();
});

export default router;
