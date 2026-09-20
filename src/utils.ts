import type { z } from "zod";

// Lỗi trùng khóa UNIQUE của MySQL/MariaDB: cho biết ô nào bị trùng
export function getDuplicateField(error: unknown): "username" | "email" | null {
    const { code, message } = error as { code?: string; message?: string };
    if (code !== "ER_DUP_ENTRY" || !message) return null;
    if (message.includes("uq_users_email")) return "email";
    if (message.includes("uq_users_username")) return "username";
    return null;
}

// Đổi lỗi kiểm tra của zod thành { tênÔ: "thông báo" }
export function collectErrors(error: z.ZodError) {
    const errors: Record<string, string> = {};
    for (const issue of error.issues) {
        const field = String(issue.path[0] ?? "form");
        if (!errors[field]) errors[field] = issue.message;
    }
    return errors;
}