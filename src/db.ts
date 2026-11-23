import mysql from "mysql2/promise";

// Các giá trị lấy từ file .env (được nạp ở đầu index.ts)
export const pool = mysql.createPool({
    host: process.env.DB_HOST ?? "127.0.0.1",
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? "root",
    password: process.env.DB_PASSWORD ?? "",
    database: process.env.DB_NAME ?? "card_shop",
    waitForConnections: true,
    connectionLimit: 10,
    // Nhiều dịch vụ MySQL trên cloud bắt buộc SSL. Đặt DB_SSL=true trên Render nếu cần.
    ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== "false" } : undefined,
});
