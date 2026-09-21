import jwt from "jsonwebtoken";
import type { JwtPayload } from "jsonwebtoken";
import type { Request, Response } from "express";

const secret = process.env.JWT_SECRET;
if (!secret) {
    throw new Error("Thiếu JWT_SECRET trong file .env (xem .env.example)");
}

export const COOKIE_NAME = "token";
const SESSION_SECONDS = 60 * 60 * 24; // 1 ngày (cookie mất khi đóng trình duyệt)
const REMEMBER_SECONDS = 60 * 60 * 24 * 30; // 30 ngày khi chọn "Ghi nhớ"

const cookieOptions = {
    httpOnly: true, // JavaScript trên trang không đọc được cookie này
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production", // bản chạy thật phải dùng HTTPS
};

function signToken(userId: number, remember: boolean) {
    return jwt.sign({}, secret as string, {
        subject: String(userId),
        expiresIn: remember ? REMEMBER_SECONDS : SESSION_SECONDS,
    });
}

export function setAuthCookie(res: Response, userId: number, remember: boolean) {
    res.cookie(COOKIE_NAME, signToken(userId, remember), {
        ...cookieOptions,
        maxAge: remember ? REMEMBER_SECONDS * 1000 : undefined,
    });
}

export function clearAuthCookie(res: Response) {
    res.clearCookie(COOKIE_NAME, cookieOptions);
}

// Trả về id người dùng nếu cookie hợp lệ, ngược lại trả về null
export function getUserId(req: Request): number | null {
    const token = req.cookies?.[COOKIE_NAME];
    if (typeof token !== "string") return null;

    try {
        const payload = jwt.verify(token, secret as string) as JwtPayload;
        const id = Number(payload.sub);
        return Number.isInteger(id) ? id : null;
    } catch {
        return null; // hết hạn hoặc bị sửa
    }
}
