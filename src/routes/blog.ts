import { Router } from "express";
import { z } from "zod";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "../db";
import { requireAdmin } from "../middleware";
import type { CurrentUser } from "../middleware";
import { collectErrors } from "../utils";

// Blog: ai cũng đọc được, chỉ admin mới đăng / xóa bài
const router = Router();

// Hiện chỉ có một danh mục. Muốn thêm danh mục thì thêm vào đây (và dropdown ở frontend).
const BLOG_CATEGORIES = ["yugioh"] as const;

interface PostRow extends RowDataPacket {
    id: number;
    title: string;
    category: string;
    content: string;
    author: string | null;
    created_at: Date;
    updated_at: Date;
}

const toPost = (row: PostRow, full: boolean) => ({
    id: row.id,
    title: row.title,
    category: row.category,
    author: row.author,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Danh sách chỉ cần đoạn trích; trang chi tiết mới cần toàn bộ nội dung
    ...(full
        ? { content: row.content }
        : { excerpt: row.content.length > 220 ? `${row.content.slice(0, 220).trimEnd()}…` : row.content }),
});

const SELECT_POST = `
    SELECT p.id, p.title, p.category, p.content, u.username AS author, p.created_at, p.updated_at
    FROM blog_posts p
    LEFT JOIN users u ON u.id = p.author_id`;

const listQuerySchema = z.object({
    page: z.coerce.number().int().min(1).catch(1),
    pageSize: z.coerce.number().int().min(1).max(30).catch(9),
    category: z.enum(BLOG_CATEGORIES).optional().catch(undefined),
});

router.get("/", async (req, res) => {
    const { page, pageSize, category } = listQuerySchema.parse(req.query);
    const whereSql = category ? "WHERE p.category = ?" : "";
    const params = category ? [category] : [];

    try {
        const [[{ total }]] = await pool.query<(RowDataPacket & { total: number })[]>(
            `SELECT COUNT(*) AS total FROM blog_posts p ${whereSql}`,
            params,
        );
        const [rows] = await pool.query<PostRow[]>(
            `${SELECT_POST} ${whereSql} ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?`,
            [...params, pageSize, (page - 1) * pageSize],
        );

        res.json({
            posts: rows.map((row) => toPost(row, false)),
            total: Number(total),
            page,
            pageSize,
            totalPages: Math.max(1, Math.ceil(Number(total) / pageSize)),
        });
    } catch (error) {
        console.error("Lỗi lấy danh sách bài viết:", error);
        res.status(500).json({ message: "Không thể tải bài viết" });
    }
});

router.get("/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
        res.status(404).json({ message: "Không tìm thấy bài viết" });
        return;
    }

    const [rows] = await pool.query<PostRow[]>(`${SELECT_POST} WHERE p.id = ?`, [id]);
    if (!rows[0]) {
        res.status(404).json({ message: "Không tìm thấy bài viết" });
        return;
    }
    res.json({ post: toPost(rows[0], true) });
});

const createPostSchema = z.object({
    title: z.string().trim().min(5, "Tiêu đề cần ít nhất 5 ký tự").max(200, "Tiêu đề tối đa 200 ký tự"),
    category: z.enum(BLOG_CATEGORIES, { message: "Danh mục không hợp lệ" }).default("yugioh"),
    content: z.string().trim().min(20, "Nội dung cần ít nhất 20 ký tự").max(50_000, "Nội dung quá dài"),
});

router.post("/", requireAdmin, async (req, res) => {
    const parsed = createPostSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ message: "Dữ liệu bài viết không hợp lệ", errors: collectErrors(parsed.error) });
        return;
    }

    const author = res.locals.user as CurrentUser;
    const { title, category, content } = parsed.data;

    const [result] = await pool.execute<ResultSetHeader>(
        "INSERT INTO blog_posts (title, category, content, author_id) VALUES (?, ?, ?, ?)",
        [title, category, content, author.id],
    );
    const [rows] = await pool.query<PostRow[]>(`${SELECT_POST} WHERE p.id = ?`, [result.insertId]);
    res.status(201).json({ post: toPost(rows[0], true) });
});

router.delete("/:id", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const [result] = await pool.execute<ResultSetHeader>("DELETE FROM blog_posts WHERE id = ?", [
        Number.isInteger(id) ? id : 0,
    ]);
    if (result.affectedRows === 0) {
        res.status(404).json({ message: "Không tìm thấy bài viết" });
        return;
    }
    res.status(204).end();
});

export default router;
