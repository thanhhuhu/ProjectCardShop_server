import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import type { NextFunction, Request, Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import authRouter from "./routes/auth";
import adminRouter from "./routes/admin";
import productsRouter from "./routes/products";
import adminProductsRouter from "./routes/adminProducts";
import ordersRouter from "./routes/orders";
import adminOrdersRouter from "./routes/adminOrders";
import blogRouter from "./routes/blog";
import reviewsRouter from "./routes/reviews";
import wishlistRouter from "./routes/wishlist";
import discountsRouter from "./routes/discounts";
import stockNotifyRouter from "./routes/stockNotify";
import { UPLOAD_ROOT } from "./uploads";
import { pool } from "./db";

const app = express();

// Render đứng sau một proxy: cần dòng này để req.ip là IP thật của người dùng (dùng cho rate limit)
app.set("trust proxy", 1);

const allowedOrigins = (process.env.FRONTEND_URL ?? (process.env.NODE_ENV === "production" ? "" : "http://localhost:5173"))
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

if (allowedOrigins.length === 0) {
    console.warn("Cảnh báo: FRONTEND_URL chưa được cấu hình, mọi request từ trình duyệt sẽ bị CORS chặn.");
}

// CORS cho frontend Vercel -> backend Render.
// Cookie đăng nhập cần credentials để browser gửi cookie qua API.
app.use((req, res, next) => {
    const origin = req.headers.origin;

    if (origin && allowedOrigins.includes(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
        res.setHeader("Vary", "Origin");
    }

    if (req.method === "OPTIONS") {
        res.sendStatus(204);
        return;
    }

    next();
});

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

// Giới hạn số lần thử đăng nhập / đăng ký để chống dò mật khẩu
// Chỉ đếm các lần THẤT BẠI. Khi chạy trên máy (không phải production) thì nới rộng để dễ test.
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: process.env.NODE_ENV === "production" ? 10 : 100,
    skipSuccessfulRequests: true,
    // Khi frontend gọi qua proxy của Vercel, mọi request có thể mang chung IP của Vercel.
    // Đếm theo IP + tài khoản để một người gõ sai không làm khóa đăng nhập của tất cả mọi người.
    keyGenerator: (req) => {
        const body = (req.body ?? {}) as { account?: unknown; email?: unknown };
        const who = String(body.account ?? body.email ?? "").trim().toLowerCase().slice(0, 255);
        return `${ipKeyGenerator(req.ip ?? "")}|${who}`;
    },
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { message: "Bạn thử quá nhiều lần, vui lòng đợi 15 phút rồi thử lại" },
});
// Không cho trình duyệt / CDN của Vercel lưu đệm dữ liệu API
// (tránh trường hợp thông tin đăng nhập của người này bị trả cho người khác)
app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
});

app.use("/api/auth/login", authLimiter);
app.use("/api/auth/register", authLimiter);

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
app.use("/api/admin/orders", adminOrdersRouter);
app.use("/api/admin", adminRouter);

app.use("/api/products", productsRouter);
app.use("/api/orders", ordersRouter);
app.use("/api/blog", blogRouter);
app.use("/api/reviews", reviewsRouter);
app.use("/api/wishlist", wishlistRouter);
app.use("/api/discounts", discountsRouter);
app.use("/api/stock-notify", stockNotifyRouter);

// Lỗi không được bắt ở route (ví dụ mất kết nối database) vẫn trả JSON thay vì trang HTML
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("Lỗi không mong muốn:", error);
    if (res.headersSent) return;
    const status = (error as { status?: number }).status;
    if (status && status >= 400 && status < 500) {
        res.status(status).json({ message: "Yêu cầu không hợp lệ" });
        return;
    }
    res.status(500).json({ message: "Lỗi máy chủ, vui lòng thử lại sau" });
});

const port = Number(process.env.PORT ?? 10000);

app.listen(port, "0.0.0.0", () => {
    console.log(`API đang chạy on port ${port}`);
});
