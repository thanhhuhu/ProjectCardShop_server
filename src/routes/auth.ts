import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "../db";
import { clearAuthCookie, getUserId, setAuthCookie } from "../auth";
import { collectErrors, getDuplicateField } from "../utils";

const router = Router();

interface UserRow extends RowDataPacket {
    id: number;
    username: string;
    email: string;
    password_hash: string;
    role: "user" | "admin";
}

const registerSchema = z.object({
    username: z.string().trim().min(3, "Tên tài khoản cần ít nhất 3 ký tự").max(50, "Tên tài khoản tối đa 50 ký tự"),
    email: z.string().trim().toLowerCase().email("Địa chỉ email không hợp lệ").max(255, "Email quá dài"),
    // bcrypt chỉ xử lý tối đa 72 byte đầu của mật khẩu
    password: z.string().min(8, "Mật khẩu cần ít nhất 8 ký tự").max(72, "Mật khẩu tối đa 72 ký tự"),
});

const loginSchema = z.object({
    account: z.string().trim().min(1, "Vui lòng nhập tên tài khoản hoặc email").max(255),
    password: z.string().min(1, "Vui lòng nhập mật khẩu").max(200),
    remember: z.boolean().default(false),
});

// Băm sẵn một mật khẩu giả: khi tài khoản không tồn tại vẫn so sánh một lần,
// để thời gian phản hồi không tiết lộ tài khoản nào có thật
const DUMMY_HASH = bcrypt.hashSync("dummy-password", 10);

/* ---------- Đăng ký (xong là đăng nhập luôn) ---------- */

router.post("/register", async (req, res) => {
    const parsed = registerSchema.safeParse(req.body);

    if (!parsed.success) {
        res.status(400).json({ message: "Dữ liệu không hợp lệ", errors: collectErrors(parsed.error) });
        return;
    }

    const { username, email, password } = parsed.data;

    try {
        const passwordHash = await bcrypt.hash(password, 10);
        const [result] = await pool.execute<ResultSetHeader>(
            "INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)",
            [username, email, passwordHash],
        );

        setAuthCookie(res, result.insertId, false);
        // Không bao giờ trả mật khẩu (kể cả bản băm) về cho trình duyệt
        res.status(201).json({ user: { id: result.insertId, username, email, role: "user" } });
    } catch (error) {
        const duplicate = getDuplicateField(error);
        if (duplicate) {
            const message = duplicate === "email" ? "Email này đã được sử dụng" : "Tên tài khoản đã tồn tại";
            res.status(409).json({ message, errors: { [duplicate]: message } });
            return;
        }

        console.error("Lỗi đăng ký:", error);
        res.status(500).json({ message: "Lỗi máy chủ, vui lòng thử lại sau" });
    }
});

/* ---------- Đăng nhập bằng tên tài khoản hoặc email ---------- */

router.post("/login", async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);

    if (!parsed.success) {
        res.status(400).json({ message: "Dữ liệu không hợp lệ", errors: collectErrors(parsed.error) });
        return;
    }

    const { account, password, remember } = parsed.data;

    try {
        const [rows] = await pool.execute<UserRow[]>(
            "SELECT id, username, email, password_hash, role FROM users WHERE username = ? OR email = ? LIMIT 1",
            [account, account.toLowerCase()],
        );
        const user: UserRow | undefined = rows[0];

        const passwordOk = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
        if (!user || !passwordOk) {
            // Cố ý dùng một thông báo chung, không cho biết sai tài khoản hay sai mật khẩu
            res.status(401).json({ message: "Tài khoản hoặc mật khẩu không đúng" });
            return;
        }

        setAuthCookie(res, user.id, remember);
        res.json({ user: { id: user.id, username: user.username, email: user.email, role: user.role } });
    } catch (error) {
        console.error("Lỗi đăng nhập:", error);
        res.status(500).json({ message: "Lỗi máy chủ, vui lòng thử lại sau" });
    }
});

/* ---------- Ai đang đăng nhập? (frontend gọi khi mở trang) ---------- */

router.get("/me", async (req, res) => {
    const userId = getUserId(req);
    if (!userId) {
        res.json({ user: null }); // chưa đăng nhập không phải lỗi
        return;
    }

    try {
        const [rows] = await pool.execute<UserRow[]>(
            "SELECT id, username, email, role FROM users WHERE id = ?",
            [userId],
        );
        const user: UserRow | undefined = rows[0];

        if (!user) {
            clearAuthCookie(res); // tài khoản đã bị xóa
            res.json({ user: null });
            return;
        }

        res.json({ user: { id: user.id, username: user.username, email: user.email, role: user.role } });
    } catch (error) {
        console.error("Lỗi lấy thông tin người dùng:", error);
        res.status(500).json({ message: "Lỗi máy chủ" });
    }
});

/* ---------- Đăng xuất ---------- */

router.post("/logout", (_req, res) => {
    clearAuthCookie(res);
    res.json({ ok: true });
});

export default router;
