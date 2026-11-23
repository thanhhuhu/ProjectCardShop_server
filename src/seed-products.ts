// Nhập dữ liệu từ file src/data/products.ts (của frontend) vào bảng products, kèm ảnh.
// Chạy (trong thư mục server):  npm run seed
// Chạy lại nhiều lần được: thẻ đã có (cùng mã + độ hiếm) sẽ được CẬP NHẬT theo file, không tạo trùng.
// Lưu ý: chạy lại sẽ ghi đè giá, tồn kho... bằng dữ liệu trong file.
//
// Script tự tìm thư mục frontend nằm CẠNH thư mục server, tên ProjectCardShop hoặc ProjectShoppingCard.
// Để ở chỗ khác thì đặt biến FRONTEND_DIR trong .env, ví dụ FRONTEND_DIR=D:/code/ProjectCardShop

import "dotenv/config";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { pool } from "./db";
import { PRODUCT_URL_PREFIX, UPLOAD_ROOT } from "./uploads";

interface SeedProduct {
    code: string;
    name: string;
    rarity: string;
    game: string;
    price: number;
    stock: number;
    imageUrl: string;
}

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

// File products.ts của frontend có dạng `import X from "../images/products/X.jpg"`.
// Vite hiểu được kiểu import này, còn Node thì không. Ở đây dạy Node: import một file ảnh
// thì trả về đường dẫn tuyệt đối của file đó, để bước sau copy ảnh sang server.
function allowImageImports() {
    const extensions = require.extensions as Record<string, (module: NodeJS.Module, filename: string) => void>;
    for (const extension of IMAGE_EXTENSIONS) {
        extensions[extension] = (module, filename) => {
            module.exports = { __esModule: true, default: filename };
        };
    }
}

function findProductsFile(): string {
    const parent = path.resolve(process.cwd(), "..");
    const roots = [
        process.env.FRONTEND_DIR,
        path.join(parent, "ProjectCardShop"),
        path.join(parent, "ProjectShoppingCard"),
    ].filter((root): root is string => Boolean(root));

    for (const root of roots) {
        const file = path.resolve(root, "src", "data", "products.ts");
        if (existsSync(file)) return file;
    }

    throw new Error(
        "Không tìm thấy src/data/products.ts của frontend. Đã thử:\n" +
            roots.map((root) => "  - " + path.resolve(root)).join("\n") +
            "\nHãy đặt FRONTEND_DIR=<đường dẫn thư mục frontend> trong file .env của server.",
    );
}

function loadProducts(): SeedProduct[] {
    allowImageImports();
    const file = findProductsFile();
    console.log(`Đọc dữ liệu từ ${file}`);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const module = require(file) as { products?: SeedProduct[] };
    if (!Array.isArray(module.products)) throw new Error("File products.ts không export `products`.");
    return module.products;
}

// Ảnh nằm trong thư mục frontend: copy sang server/uploads/products với tên cố định (seed-<tên file>),
// chạy lại seed sẽ ghi đè đúng file đó chứ không sinh thêm file mới.
async function copyImage(imageUrl: string): Promise<string> {
    if (!path.isAbsolute(imageUrl) || !existsSync(imageUrl)) return imageUrl;

    const dir = path.join(UPLOAD_ROOT, "products");
    await fs.mkdir(dir, { recursive: true });
    const filename = `seed-${path.basename(imageUrl).replace(/[^\w.-]/g, "_")}`;
    await fs.copyFile(imageUrl, path.join(dir, filename));
    return `${PRODUCT_URL_PREFIX}${filename}`;
}

async function main() {
    const products = loadProducts();

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
        if (!path.isAbsolute(p.imageUrl) && !p.imageUrl.startsWith("/") && !p.imageUrl.startsWith("http")) {
            console.warn(`Cảnh báo: đường dẫn ảnh nên bắt đầu bằng "/": ${p.code} → ${p.imageUrl}`);
        }
    }

    if (problems.length > 0) {
        console.error("\nKhông nhập được, hãy sửa các lỗi sau trong products.ts rồi chạy lại:\n");
        for (const problem of problems) console.error(" - " + problem);
        process.exitCode = 1;
        return;
    }

    // 2. Copy ảnh từ frontend sang server
    for (const p of products) {
        p.imageUrl = await copyImage(p.imageUrl);
    }

    // 3. Nhập theo thứ tự ngược để thẻ đứng đầu file có id lớn nhất, tức là "mới cập nhật" nhất
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
