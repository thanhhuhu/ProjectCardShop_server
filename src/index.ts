import "dotenv/config"; // phải nằm đầu tiên để .env được nạp trước khi kết nối database
import express from "express";
import cookieParser from "cookie-parser";
import authRouter from "./routes/auth";
import adminRouter from "./routes/admin";
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
app.use("/api/admin", adminRouter);

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => {
    console.log(`API đang chạy tại http://localhost:${port}`);
});