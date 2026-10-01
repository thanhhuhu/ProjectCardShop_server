import jwt from "jsonwebtoken";
import type { JwtPayload } from "jsonwebtoken";
import type { Request, Response } from "express";

const secret = process.env.JWT_SECRET;
if (!secret) {
    throw new Error("Thiếu JWT_SECRET. Hãy cấu hình JWT_SECRET trên Render.");
}

export const COOKIE_NAME = "token";
const SESSION_SECONDS = 60 * 60 * 24;
const REMEMBER_SECONDS = 60 * 60 * 24 * 30;

const isProduction = process.env.NODE_ENV === "production";

const cookieOptions = {
    httpOnly: true,
    // Vercel frontend và Render backend là hai site khác nhau.
    // Production cần SameSite=None + Secure để cookie được gửi qua API requests.
    sameSite: isProduction ? ("none" as const) : ("lax" as const),
    secure: isProduction,
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

export function getUserId(req: Request): number | null {
    const token = req.cookies?.[COOKIE_NAME];
    if (typeof token !== "string") return null;

    try {
        const payload = jwt.verify(token, secret as string) as JwtPayload;
        const id = Number(payload.sub);
        return Number.isInteger(id) ? id : null;
    } catch {
        return null;
    }
}
