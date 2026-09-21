import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "../db";
import { requireAdmin } from "../middleware";
import type { CurrentUser } from "../middleware";
import { collectErrors, getDuplicateField } from "../utils";

const router = Router();

// Mọi đường dẫn trong file này đều chỉ dành cho admin
router.use(requireAdmin);

const PAGE_SIZE = 10;

interface AdminUserRow extends RowDataPacket {
    id: number;
    username: string;
    email: string;
    role: "user" | "admin";
    created_at: Date;
}

const toUser = (row: AdminUserRow) => ({
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role,
    createdAt: row.created_at,
});

function parseId(value: unknown): number | null {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
}

const updateSchema = z.object({
    username: z.string().trim().min(3, "Tên tài khoản cần ít nhất 3 ký tự").max(50, "Tên tài khoản tối đa 50 ký tự").optional(),
    email: z.string().trim().toLowerCase().email("Địa chỉ email không hợp lệ").max(255, "Email quá dài").optional(),
    role: z.enum(["user", "admin"], { message: "Vai trò không hợp lệ" }).optional(),
    // Đặt lại mật khẩu cho người dùng (bỏ trống nếu không đổi)
    password: z.string().min(8, "Mật khẩu cần ít nhất 8 ký tự").max(72, "Mật khẩu tối đa 72 ký tự").optional(),
});

/* ---------- Danh sách + tìm kiếm + phân trang ---------- */

router.get("/users", async (req, res) => {
    const search = String(req.query.search ?? "").trim().slice(0, 100);
    const page = Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1);

    // Escape % _ \ để người dùng gõ ký tự đặc biệt vẫn tìm đúng nghĩa đen
    const like = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
    const where = search ? "WHERE username LIKE ? OR email LIKE ?" : "";
    const params = search ? [like, like] : [];

    try {
        const [countRows] = await pool.query<(RowDataPacket & { total: number })[]>(
            `SELECT COUNT(*) AS total FROM users ${where}`,
            params,
        );
        const total = Number(countRows[0].total);

        const [rows] = await pool.query<AdminUserRow[]>(
            `SELECT id, username, email, role, created_at FROM users ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
            [...params, PAGE_SIZE, (page - 1) * PAGE_SIZE],
        );

        res.json({ users: rows.map(toUser), total, page, pageSize: PAGE_SIZE });
    } catch (error) {
        console.error("Lỗi lấy danh sách người dùng:", error);
        res.status(500).json({ message: "Lỗi máy chủ, vui lòng thử lại sau" });
    }
});

/* ---------- Sửa thông tin ---------- */

router.patch("/users/:id", async (req, res) => {
    const actor = res.locals.user as CurrentUser;
    const id = parseId(req.params.id);
    if (!id) {
        res.status(400).json({ message: "ID không hợp lệ" });
        return;
    }

    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ message: "Dữ liệu không hợp lệ", errors: collectErrors(parsed.error) });
        return;
    }

    const { username, email, role, password } = parsed.data;

    if (username === undefined && email === undefined && role === undefined && password === undefined) {
        res.status(400).json({ message: "Không có thông tin nào để cập nhật" });
        return;
    }

    // Không cho tự hạ quyền chính mình, để hệ thống luôn còn ít nhất một admin
    if (id === actor.id && role !== undefined && role !== actor.role) {
        const message = "Bạn không thể tự đổi vai trò của chính mình";
        res.status(400).json({ message, errors: { role: message } });
        return;
    }

    try {
        const [existing] = await pool.execute<RowDataPacket[]>("SELECT id FROM users WHERE id = ?", [id]);
        if (existing.length === 0) {
            res.status(404).json({ message: "Không tìm thấy người dùng" });
            return;
        }

        // Tên cột viết cố định trong code, chỉ giá trị lấy từ người dùng và luôn đi qua dấu ?
        const assignments: string[] = [];
        const values: (string | number)[] = [];
        if (username !== undefined) {
            assignments.push("username = ?");
            values.push(username);
        }
        if (email !== undefined) {
            assignments.push("email = ?");
            values.push(email);
        }
        if (role !== undefined) {
            assignments.push("role = ?");
            values.push(role);
        }
        if (password !== undefined) {
            assignments.push("password_hash = ?");
            values.push(await bcrypt.hash(password, 10));
        }

        await pool.execute(`UPDATE users SET ${assignments.join(", ")} WHERE id = ?`, [...values, id]);

        const [rows] = await pool.execute<AdminUserRow[]>(
            "SELECT id, username, email, role, created_at FROM users WHERE id = ?",
            [id],
        );
        res.json({ user: toUser(rows[0]) });
    } catch (error) {
        const duplicate = getDuplicateField(error);
        if (duplicate) {
            const message = duplicate === "email" ? "Email này đã được sử dụng" : "Tên tài khoản đã tồn tại";
            res.status(409).json({ message, errors: { [duplicate]: message } });
            return;
        }

        console.error("Lỗi cập nhật người dùng:", error);
        res.status(500).json({ message: "Lỗi máy chủ, vui lòng thử lại sau" });
    }
});

/* ---------- Xóa ---------- */

router.delete("/users/:id", async (req, res) => {
    const actor = res.locals.user as CurrentUser;
    const id = parseId(req.params.id);
    if (!id) {
        res.status(400).json({ message: "ID không hợp lệ" });
        return;
    }

    if (id === actor.id) {
        res.status(400).json({ message: "Bạn không thể xóa chính tài khoản đang đăng nhập" });
        return;
    }

    try {
        const [result] = await pool.execute<ResultSetHeader>("DELETE FROM users WHERE id = ?", [id]);
        if (result.affectedRows === 0) {
            res.status(404).json({ message: "Không tìm thấy người dùng" });
            return;
        }
        res.json({ ok: true });
    } catch (error) {
        console.error("Lỗi xóa người dùng:", error);
        res.status(500).json({ message: "Lỗi máy chủ, vui lòng thử lại sau" });
    }
});

export default router;
