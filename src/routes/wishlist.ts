import { Router } from "express";
import { z } from "zod";
import type { RowDataPacket } from "mysql2";
import { pool } from "../db";
import { requireAuth } from "../middleware";
import type { CurrentUser } from "../middleware";

const router = Router();
router.use(requireAuth);

interface WishProductRow extends RowDataPacket {
    id: number;
    code: string;
    name: string;
    archetype: string;
    rarity: string;
    game: string;
    price: number;
    stock: number;
    image_url: string;
}

const toProduct = (r: WishProductRow) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    archetype: r.archetype,
    rarity: r.rarity,
    game: r.game,
    price: Number(r.price),
    stock: r.stock,
    imageUrl: r.image_url,
});

// Danh sách thẻ đã thích
router.get("/", async (_req, res) => {
    const me = res.locals.user as CurrentUser;
    const [rows] = await pool.query<WishProductRow[]>(
        `SELECT p.id, p.code, p.name, p.archetype, p.rarity, p.game, p.price, p.stock, p.image_url
         FROM wishlists w JOIN products p ON p.id = w.product_id
         WHERE w.user_id = ? ORDER BY w.created_at DESC`,
        [me.id],
    );
    res.json({ products: rows.map(toProduct) });
});

// Chỉ id (để tô tim ngoài trang danh sách)
router.get("/ids", async (_req, res) => {
    const me = res.locals.user as CurrentUser;
    const [rows] = await pool.query<(RowDataPacket & { product_id: number })[]>(
        "SELECT product_id FROM wishlists WHERE user_id = ?",
        [me.id],
    );
    res.json({ ids: rows.map((r) => r.product_id) });
});

const addSchema = z.object({ productId: z.coerce.number().int().positive() });

router.post("/", async (req, res) => {
    const parsed = addSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ message: "Dữ liệu không hợp lệ" });
        return;
    }
    const me = res.locals.user as CurrentUser;
    await pool.execute("INSERT IGNORE INTO wishlists (user_id, product_id) VALUES (?, ?)", [me.id, parsed.data.productId]);
    res.status(201).json({ ok: true });
});

router.delete("/:productId", async (req, res) => {
    const productId = Number(req.params.productId);
    const me = res.locals.user as CurrentUser;
    await pool.execute("DELETE FROM wishlists WHERE user_id = ? AND product_id = ?", [
        me.id,
        Number.isInteger(productId) ? productId : 0,
    ]);
    res.status(204).end();
});

export default router;
