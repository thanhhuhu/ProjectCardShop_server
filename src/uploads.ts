import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { v2 as cloudinary } from "cloudinary";

// Thư mục lưu ảnh: server/uploads (cạnh thư mục src).
// Dùng process.cwd() để tương thích với CommonJS build trên Render.
export const UPLOAD_ROOT = path.resolve(process.cwd(), "uploads");
const PRODUCT_DIR = path.join(UPLOAD_ROOT, "products");

// Thư mục trên Cloudinary để ảnh gọn gàng
const CLOUDINARY_FOLDER = "card-shop/products";

// Có Cloudinary (đặt CLOUDINARY_URL hoặc đủ 3 biến) thì lưu ảnh lên đó thay vì ổ đĩa.
// Ổ đĩa Render là tạm thời nên ảnh upload sẽ mất khi deploy lại; Cloudinary thì không.
function cloudinaryEnabled(): boolean {
    if (process.env.CLOUDINARY_URL) {
        cloudinary.config({ secure: true });
        return true;
    }
    const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
    if (CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET) {
        cloudinary.config({
            cloud_name: CLOUDINARY_CLOUD_NAME,
            api_key: CLOUDINARY_API_KEY,
            api_secret: CLOUDINARY_API_SECRET,
            secure: true,
        });
        return true;
    }
    return false;
}

function uploadToCloudinary(buffer: Buffer): Promise<string> {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            { folder: CLOUDINARY_FOLDER, resource_type: "image", public_id: randomUUID() },
            (error, result) => {
                if (error || !result) reject(error ?? new Error("Cloudinary không trả về kết quả"));
                else resolve(result.secure_url);
            },
        );
        stream.end(buffer);
    });
}

// Lấy public_id từ một URL Cloudinary để xóa, ví dụ
// https://res.cloudinary.com/demo/image/upload/v1699999999/card-shop/products/abc.jpg -> card-shop/products/abc
function cloudinaryPublicId(url: string): string | null {
    const match = url.match(/\/upload\/(?:v\d+\/)?(.+)\.[a-zA-Z0-9]+$/);
    return match ? match[1] : null;
}

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

// Lưu ảnh với tên ngẫu nhiên (không dùng tên file do người dùng đặt) và trả về địa chỉ công khai.
// Có Cloudinary -> trả URL https của Cloudinary; không thì lưu ổ đĩa và trả /uploads/products/...
export async function saveProductImage(buffer: Buffer, extension: string): Promise<string> {
    if (cloudinaryEnabled()) {
        return uploadToCloudinary(buffer);
    }
    await fs.mkdir(PRODUCT_DIR, { recursive: true });
    const filename = `${randomUUID()}.${extension}`;
    await fs.writeFile(path.join(PRODUCT_DIR, filename), buffer);
    return `${PRODUCT_URL_PREFIX}${filename}`;
}

// Xóa ảnh đã tải lên khi không còn thẻ nào dùng.
// - Ảnh Cloudinary: xóa trên Cloudinary (cố gắng, lỗi thì bỏ qua).
// - Ảnh ổ đĩa (/uploads/products/...): xóa file.
// - Ảnh /images/... của frontend hay địa chỉ ngoài khác: bỏ qua.
export async function deleteUploadedImage(imageUrl: string): Promise<void> {
    if (imageUrl.includes("res.cloudinary.com")) {
        if (!cloudinaryEnabled()) return;
        const publicId = cloudinaryPublicId(imageUrl);
        if (!publicId) return;
        try {
            await cloudinary.uploader.destroy(publicId);
        } catch {
            // Xóa không được thì bỏ qua, ảnh thừa trên Cloudinary không gây hại
        }
        return;
    }

    if (!imageUrl.startsWith(PRODUCT_URL_PREFIX)) return;
    const filename = path.basename(imageUrl);
    try {
        await fs.unlink(path.join(PRODUCT_DIR, filename));
    } catch {
        // File đã mất từ trước thì không sao
    }
}
