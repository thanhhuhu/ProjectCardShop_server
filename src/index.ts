import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import authRouter from "./routes/auth";
import adminRouter from "./routes/admin";
import productsRouter from "./routes/products";
import adminProductsRouter from "./routes/adminProducts";
import ordersRouter from "./routes/orders";
import { UPLOAD_ROOT } from "./uploads";
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

// Ảnh do admin tải lên.
app.use(
    "/uploads",
    express.static(UPLOAD_ROOT, {
        maxAge: "7d",
        immutable: true,
        setHeaders: (res) => res.setHeader("X-Content-Type-Options", "nosniff"),
    }),
);

// Route sản phẩm admin phải đứng trước "/api/admin"
app.use("/api/admin/products", adminProductsRouter);
app.use("/api/admin", adminRouter);

app.use("/api/products", productsRouter);
app.use("/api/orders", ordersRouter);

const port = Number(process.env.PORT ?? 10000);

app.listen(port, "0.0.0.0", () => {
    console.log(`API đang chạy on port ${port}`);
});
