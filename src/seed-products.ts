// Nhập dữ liệu từ file src/data/products.ts (của frontend) vào bảng products.
// Chạy:  npm run seed
// Chạy lại nhiều lần được: thẻ đã có (cùng mã + độ hiếm) sẽ được CẬP NHẬT theo file, không tạo trùng.
// Lưu ý: chạy lại sẽ ghi đè giá, tồn kho... bằng dữ liệu trong file.

import "dotenv/config";
import { pool } from "./db";

interface SeedProduct {
    code: string;
    name: string;
    rarity: string;
    game: string;
    price: number;
    stock: number;
    imageUrl: string;
}

// Tìm file dữ liệu sản phẩm của frontend. Thử lần lượt các vị trí thường gặp.
async function loadProducts(): Promise<SeedProduct[]> {
    const candidates = [
        "../../ProjectShoppingCard/src/data/products", // thư mục server nằm cạnh thư mục ProjectShoppingCard
        "../../src/data/products", // thư mục server nằm ngay trong thư mục gốc của frontend
    ];

    for (const path of candidates) {
        try {
            const module = await import(path);
            return module.products as SeedProduct[];
        } catch (error) {
            if ((error as { code?: string }).code !== "ERR_MODULE_NOT_FOUND") throw error;
        }
    }

    throw new Error(
        "Không tìm thấy file src/data/products.ts của frontend. Hãy sửa danh sách đường dẫn trong hàm loadProducts (seed-products.ts).",
    );
}

async function main() {
    const products = await loadProducts();

    // 1. Kiểm tra dữ liệu trước khi nhập, báo rõ thẻ nào sai
    const seen = new Map<string, string>();
    const problems: string[] = [];

    for (const p of products) {
        const key = `${p.code}|${p.rarity}`.toLowerCase();
        if (seen.has(key)) {
            problems.push(`Trùng mã + độ hiếm: ${p.code} (${p.rarity}) — "${p.name}" và "${seen.get(key)}"`);
        }
        seen.set(key, p.name);

        if (!Number.isInteger(p.price) || p.price < 0) {
            problems.push(`Giá không hợp lệ: ${p.code} "${p.name}" (${p.price})`);
        }
        if (!Number.isInteger(p.stock) || p.stock < 0) {
            problems.push(`Tồn kho không hợp lệ: ${p.code} "${p.name}" (${p.stock})`);
        }
        if (!p.imageUrl.startsWith("/") && !p.imageUrl.startsWith("http")) {
            console.warn(`Cảnh báo: đường dẫn ảnh nên bắt đầu bằng "/": ${p.code} → ${p.imageUrl}`);
        }
    }

    if (problems.length > 0) {
        console.error("\nKhông nhập được, hãy sửa các lỗi sau trong products.ts rồi chạy lại:\n");
        for (const problem of problems) console.error(" - " + problem);
        process.exitCode = 1;
        return;
    }

    // 2. Nhập theo thứ tự ngược để thẻ đứng đầu file có id lớn nhất, tức là "mới cập nhật" nhất
    const rows = [...products]
        .reverse()
        .map((p) => [p.code, p.name, p.rarity, p.game, p.price, p.stock, p.imageUrl]);

    await pool.query(
        `INSERT INTO products (code, name, rarity, game, price, stock, image_url)
         VALUES ?
         ON DUPLICATE KEY UPDATE
           name = VALUES(name), game = VALUES(game), price = VALUES(price),
           stock = VALUES(stock), image_url = VALUES(image_url)`,
        [rows],
    );

    console.log(`Đã nhập hoặc cập nhật ${rows.length} sản phẩm.`);
}

main()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
