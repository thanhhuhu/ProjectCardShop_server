import type { NextFunction, Request, Response } from "express";
import type { RowDataPacket } from "mysql2";
import { pool } from "./db";
import { clearAuthCookie, getUserId } from "./auth";

export interface CurrentUser {
    id: number;
    username: string;
    email: string;
    role: "user" | "admin";
}

interface CurrentUserRow extends RowDataPacket, CurrentUser {}

// Chỉ cho admin đi tiếp. Vai trò luôn được đọc lại từ database ở mỗi yêu cầu (không tin vào cookie),
// nên khi bạn hạ quyền hoặc xóa một tài khoản, hiệu lực có ngay.
export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
    try {
        const userId = getUserId(req);
        if (!userId) {
            res.status(401).json({ message: "Bạn chưa đăng nhập" });
            return;
        }

        const [rows] = await pool.execute<CurrentUserRow[]>(
            "SELECT id, username, email, role FROM users WHERE id = ?",
            [userId],
        );
        const user: CurrentUserRow | undefined = rows[0];

        if (!user) {
            clearAuthCookie(res);
            res.status(401).json({ message: "Bạn chưa đăng nhập" });
            return;
        }

        if (user.role !== "admin") {
            res.status(403).json({ message: "Bạn không có quyền truy cập" });
            return;
        }

        res.locals.user = { id: user.id, username: user.username, email: user.email, role: user.role } satisfies CurrentUser;
        next();
    } catch (error) {
        next(error);
    }
}
