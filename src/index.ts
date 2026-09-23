import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import authRouter from "./routes/auth";
import adminRouter from "./routes/admin";
<<<<<<< HEAD
import productsRouter from "./routes/products";
import adminProductsRouter from "./routes/adminProducts";
import { UPLOAD_ROOT } from "./uploads";
=======
import ordersRouter from "./routes/orders";
>>>>>>> f869c10cc04fe4da602707e1489e7575e8b5139b
import { pool } from "./db";

const app = express();

app.use(express.json());
app.use(cookieParser());

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
<<<<<<< HEAD
app.use("/api/products", productsRouter);
=======
app.use("/api/orders", ordersRouter);
>>>>>>> f869c10cc04fe4da602707e1489e7575e8b5139b

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => {
    console.log(`API đang chạy tại http://localhost:${port}`);
});
