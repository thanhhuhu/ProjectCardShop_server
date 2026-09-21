import "dotenv/config"; // phải nằm đầu tiên để .env được nạp trước khi kết nối database
import express from "express";
import cookieParser from "cookie-parser";
import authRouter from "./routes/auth";
import adminRouter from "./routes/admin";
import productsRouter from "./routes/products";
import adminProductsRouter from "./routes/adminProducts";
import { UPLOAD_ROOT } from "./uploads";
import { pool } from "./db";

const app = express();
app.use(express.json());
app.use(cookieParser());

// Mở http://localhost:3001/api/health để kiểm tra server và database đã nối được chưa
app.get("/api/health", async (_req, res) => {
    try {
        await pool.query("SELECT 1");
        res.json({ ok: true, database: "connected" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ ok: false, database: "unreachable" });
    }
});

app.use("/api/auth", authRouter);

// Ảnh do admin tải lên. Tên file là mã ngẫu nhiên nên có thể cho trình duyệt lưu lâu
app.use(
    "/uploads",
    express.static(UPLOAD_ROOT, {
        maxAge: "7d",
        immutable: true,
        setHeaders: (res) => res.setHeader("X-Content-Type-Options", "nosniff"),
    }),
);

app.use("/api/admin/products", adminProductsRouter); // đặt trước "/api/admin"
app.use("/api/admin", adminRouter);
app.use("/api/products", productsRouter);

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => {
    console.log(`API đang chạy tại http://localhost:${port}`);
});
