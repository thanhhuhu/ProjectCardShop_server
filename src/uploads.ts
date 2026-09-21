import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

// Thư mục lưu ảnh: server/uploads (cạnh thư mục src)
export const UPLOAD_ROOT = fileURLToPath(new URL("../uploads", import.meta.url));
const PRODUCT_DIR = path.join(UPLOAD_ROOT, "products");

// Địa chỉ công khai của ảnh đã tải lên, ví dụ /uploads/products/3f2a....jpg
export const PRODUCT_URL_PREFIX = "/uploads/products/";

export const MAX_IMAGE_BYTES = 3 * 1024 * 1024; // 3 MB

// Nhận biết loại ảnh bằng "chữ ký" ở đầu file. Không tin vào tên file hay loại file do trình duyệt khai báo,
// vì ai cũng có thể đổi đuôi một file bất kỳ thành .jpg.
export function detectImageExtension(buffer: Buffer): "jpg" | "png" | "webp" | null {
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";

    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(pngSignature)) return "png";

    if (
        buffer.length >= 12 &&
        buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
        buffer.subarray(8, 12).toString("ascii") === "WEBP"
    ) {
        return "webp";
    }

    return null;
}

// Lưu ảnh với tên ngẫu nhiên (không dùng tên file do người dùng đặt) và trả về địa chỉ công khai
export async function saveProductImage(buffer: Buffer, extension: string): Promise<string> {
    await fs.mkdir(PRODUCT_DIR, { recursive: true });
    const filename = `${randomUUID()}.${extension}`;
    await fs.writeFile(path.join(PRODUCT_DIR, filename), buffer);
    return `${PRODUCT_URL_PREFIX}${filename}`;
}

// Xóa file ảnh đã tải lên. Chỉ đụng tới file nằm trong thư mục uploads/products;
// ảnh kiểu /images/... (thư mục public của frontend) hay địa chỉ ngoài đều được bỏ qua.
export async function deleteUploadedImage(imageUrl: string): Promise<void> {
    if (!imageUrl.startsWith(PRODUCT_URL_PREFIX)) return;

    const filename = path.basename(imageUrl); // bỏ mọi thành phần "../"
    try {
        await fs.unlink(path.join(PRODUCT_DIR, filename));
    } catch {
        // File đã mất từ trước thì không sao
    }
}
