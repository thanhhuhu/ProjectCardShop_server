import { Router } from "express";
import { z } from "zod";
import type { RowDataPacket } from "mysql2";
import { pool } from "../db";

const router = Router();

/* ---------- Khách để email cho thẻ đang hết hàng ---------- */

const notifySchema = z.object({
    productId: z.coerce.number().int().positive(),
    email: z.string().trim().toLowerCase().email("Email không hợp lệ").max(255),
});

router.post("/", async (req, res) => {
    const parsed = notifySchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ message: "Email không hợp lệ" });
        return;
    }
    const { productId, email } = parsed.data;

    const [rows] = await pool.query<(RowDataPacket & { stock: number; name: string })[]>(
        "SELECT stock, name FROM products WHERE id = ?",
        [productId],
    );
    const product = rows[0];
    if (!product) {
        res.status(404).json({ message: "Sản phẩm không tồn tại" });
        return;
    }
    if (product.stock > 0) {
        res.status(400).json({ message: "Sản phẩm đang còn hàng" });
        return;
    }

    await pool.execute("INSERT IGNORE INTO stock_notifications (product_id, email) VALUES (?, ?)", [productId, email]);
    res.status(201).json({ ok: true, message: "Đã ghi nhận. Chúng tôi sẽ báo khi có hàng lại." });
});

export default router;

/* ---------- Gửi báo khi thẻ có hàng trở lại ---------- */

// Gọi khi admin tăng tồn kho của một thẻ từ 0 lên > 0.
// Có cấu hình email (RESEND_API_KEY + NOTIFY_FROM_EMAIL) thì gửi mail rồi xóa danh sách chờ;
// chưa cấu hình thì giữ lại danh sách và chỉ ghi log (để sau cấu hình xong vẫn gửi được).
export async function notifyBackInStock(productId: number, productName: string, siteUrl?: string): Promise<void> {
    const [rows] = await pool.query<(RowDataPacket & { email: string })[]>(
        "SELECT email FROM stock_notifications WHERE product_id = ?",
        [productId],
    );
    const emails = rows.map((r) => r.email);
    if (emails.length === 0) return;

    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.NOTIFY_FROM_EMAIL;
    if (!apiKey || !from) {
        console.log(`[stock] "${productName}" có hàng lại: ${emails.length} người chờ, nhưng chưa cấu hình email (RESEND_API_KEY/NOTIFY_FROM_EMAIL).`);
        return;
    }

    const link = siteUrl ? `${siteUrl.replace(/\/$/, "")}/product/${productId}` : "";
    let sent = 0;
    for (const email of emails) {
        try {
            const resp = await fetch("https://api.resend.com/emails", {
                method: "POST",
                headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                    from,
                    to: email,
                    subject: `"${productName}" đã có hàng trở lại`,
                    html: `<p>Thẻ <strong>${productName}</strong> bạn quan tâm đã có hàng trở lại.</p>${link ? `<p><a href="${link}">Xem sản phẩm</a></p>` : ""}`,
                }),
            });
            if (resp.ok) sent++;
        } catch (error) {
            console.error("Lỗi gửi email báo hàng:", error);
        }
    }
    // Xóa những người đã được báo để không gửi lại lần sau
    if (sent > 0) {
        await pool.execute("DELETE FROM stock_notifications WHERE product_id = ?", [productId]);
    }
    console.log(`[stock] "${productName}": đã gửi ${sent}/${emails.length} email báo hàng.`);
}
