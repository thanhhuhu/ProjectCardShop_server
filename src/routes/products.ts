import { Router } from "express";
import type { RowDataPacket } from "mysql2";
import { pool } from "../db";
import { escapeLike } from "../utils";

const router = Router();

interface ProductRow extends RowDataPacket {
    id: number;
    code: string;
    name: string;
    rarity: string;
    game: string;
    price: number;
    stock: number;
    image_url: string;
}

const COLUMNS = "id, code, name, rarity, game, price, stock, image_url";

// Đổi tên cột trong database (image_url) sang tên frontend đang dùng (imageUrl)
const toProduct = (row: ProductRow) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    rarity: row.rarity,
    game: row.game,
    price: row.price,
    stock: row.stock,
    imageUrl: row.image_url,
});

// Điểm độ hiếm, khớp với cách xếp ở frontend (Secret Rare cao hơn Ultra Rare, cao hơn Common)
const RARITY_RANK = `CASE
    WHEN rarity LIKE '%prismatic%' THEN 6
    WHEN rarity LIKE '%secret%' THEN 5
    WHEN rarity LIKE '%ultra%' THEN 4
    WHEN rarity LIKE '%super%' THEN 3
    WHEN rarity LIKE '%rare%' THEN 2
    ELSE 1 END`;

// Chỉ cho chọn các cách sắp xếp có sẵn trong danh sách này (không ghép chuỗi từ người dùng vào SQL)
const ORDER_BY: Record<string, string> = {
    newest: "id DESC",
    "price-asc": "price ASC, id DESC",
    "price-desc": "price DESC, id DESC",
    "rarity-desc": `${RARITY_RANK} DESC, price DESC, id DESC`,
    "name-asc": "name ASC, id DESC",
};

// Mỗi từ trong ô tìm kiếm phải xuất hiện trong tên hoặc mã thẻ
function searchConditions(search: string) {
    const conditions: string[] = [];
    const params: string[] = [];

    for (const word of search.split(/\s+/).filter(Boolean).slice(0, 6)) {
        const like = `%${escapeLike(word)}%`;
        conditions.push("(name LIKE ? OR code LIKE ?)");
        params.push(like, like);
    }
    return { conditions, params };
}

/* ---------- Gợi ý khi gõ vào ô tìm kiếm ---------- */
// Đặt trước "/:id" để chữ "suggest" không bị hiểu là một id

router.get("/suggest", async (req, res) => {
    const q = String(req.query.q ?? "").trim().slice(0, 100);
    if (!q) {
        res.json({ products: [] });
        return;
    }

    const { conditions, params } = searchConditions(q);
    const prefix = `${escapeLike(q)}%`;

    try {
        const [rows] = await pool.query<ProductRow[]>(
            `SELECT ${COLUMNS} FROM products
             WHERE ${conditions.join(" AND ")}
             ORDER BY (code LIKE ? OR name LIKE ?) DESC, id DESC
             LIMIT 6`,
            [...params, prefix, prefix],
        );
        res.json({ products: rows.map(toProduct) });
    } catch (error) {
        console.error("Lỗi gợi ý sản phẩm:", error);
        res.status(500).json({ message: "Lỗi máy chủ, vui lòng thử lại sau" });
    }
});

/* ---------- Danh sách: tìm kiếm, lọc theo game, sắp xếp, phân trang ---------- */

router.get("/", async (req, res) => {
    const search = String(req.query.search ?? "").trim().slice(0, 100);
    const game = String(req.query.game ?? "").trim().slice(0, 50);
    const sortKey = String(req.query.sort ?? "newest");
    const orderBy = Object.hasOwn(ORDER_BY, sortKey) ? ORDER_BY[sortKey] : ORDER_BY.newest;
    const page = Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1);
    const pageSize = Math.min(50, Math.max(1, Number.parseInt(String(req.query.pageSize ?? "20"), 10) || 20));
    const exclude = Number.parseInt(String(req.query.exclude ?? ""), 10); // bỏ một thẻ ra (dùng cho "sản phẩm tương tự")

    const { conditions, params } = searchConditions(search);
    const values: (string | number)[] = [...params];

    if (game) {
        conditions.push("game = ?");
        values.push(game);
    }
    if (Number.isInteger(exclude) && exclude > 0) {
        conditions.push("id <> ?");
        values.push(exclude);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    try {
        const [countRows] = await pool.query<(RowDataPacket & { total: number })[]>(
            `SELECT COUNT(*) AS total FROM products ${where}`,
            values,
        );
        const total = Number(countRows[0].total);

        const [rows] = await pool.query<ProductRow[]>(
            `SELECT ${COLUMNS} FROM products ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
            [...values, pageSize, (page - 1) * pageSize],
        );

        res.json({ products: rows.map(toProduct), total, page, pageSize });
    } catch (error) {
        console.error("Lỗi lấy danh sách sản phẩm:", error);
        res.status(500).json({ message: "Lỗi máy chủ, vui lòng thử lại sau" });
    }
});

/* ---------- Chi tiết một sản phẩm ---------- */

router.get("/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
        res.status(404).json({ message: "Không tìm thấy sản phẩm" });
        return;
    }

    try {
        const [rows] = await pool.execute<ProductRow[]>(`SELECT ${COLUMNS} FROM products WHERE id = ?`, [id]);
        const row: ProductRow | undefined = rows[0];

        if (!row) {
            res.status(404).json({ message: "Không tìm thấy sản phẩm" });
            return;
        }
        res.json({ product: toProduct(row) });
    } catch (error) {
        console.error("Lỗi lấy sản phẩm:", error);
        res.status(500).json({ message: "Lỗi máy chủ, vui lòng thử lại sau" });
    }
});

export default router;
