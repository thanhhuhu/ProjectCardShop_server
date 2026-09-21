import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "../db";
import { requireAdmin } from "../middleware";
import { collectErrors } from "../utils";
import { MAX_IMAGE_BYTES, deleteUploadedImage, detectImageExtension, saveProductImage } from "../uploads";

const router = Router();

// Mọi đường dẫn trong file này chỉ dành cho admin
router.use(requireAdmin);

interface ProductRow extends RowDataPacket {
    id: number;
    code: string;
    name: string;
    rarity: string;
    game: string;
    price: number;
    stock: number;
    image_url: string;
}

const COLUMNS = "id, code, name, rarity, game, price, stock, image_url";

const toProduct = (row: ProductRow) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    rarity: row.rarity,
    game: row.game,
    price: row.price,
    stock: row.stock,
    imageUrl: row.image_url,
});

// Tên trường frontend gửi lên -> tên cột trong database (viết cố định, không lấy từ người dùng)
const COLUMN_OF: Record<string, string> = {
    code: "code",
    name: "name",
    rarity: "rarity",
    game: "game",
    price: "price",
    stock: "stock",
    imageUrl: "image_url",
};

// Ảnh hợp lệ: để trống, hoặc đường dẫn trong site (/...), hoặc địa chỉ http(s). Không nhận kiểu "javascript:..."
const imageUrlSchema = z
    .string()
    .trim()
    .max(500, "Đường dẫn ảnh quá dài")
    .regex(/^$|^\/(?!\/)\S*$|^https?:\/\/\S+$/, "Đường dẫn ảnh không hợp lệ");

const productSchema = z.object({
    code: z.string().trim().min(1, "Vui lòng nhập mã thẻ").max(50, "Mã thẻ tối đa 50 ký tự"),
    name: z.string().trim().min(1, "Vui lòng nhập tên thẻ").max(255, "Tên thẻ tối đa 255 ký tự"),
    rarity: z.string().trim().min(1, "Vui lòng nhập độ hiếm").max(50, "Độ hiếm tối đa 50 ký tự"),
    game: z.string().trim().min(1, "Vui lòng chọn game").max(50, "Tên game tối đa 50 ký tự"),
    price: z.number().int("Giá phải là số nguyên").min(0, "Giá không được âm").max(1_000_000_000, "Giá quá lớn"),
    stock: z.number().int("Số lượng phải là số nguyên").min(0, "Số lượng không được âm").max(1_000_000, "Số lượng quá lớn"),
    imageUrl: imageUrlSchema,
});

const updateSchema = productSchema.partial();

function parseId(value: unknown): number | null {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
}

function isDuplicateProduct(error: unknown): boolean {
    const { code, message } = error as { code?: string; message?: string };
    return code === "ER_DUP_ENTRY" && Boolean(message?.includes("uq_products_code_rarity"));
}

const DUPLICATE_MESSAGE = "Đã có thẻ cùng mã và độ hiếm này";

// Xóa file ảnh đã tải lên nếu không còn thẻ nào dùng nó
async function removeImageIfUnused(imageUrl: string) {
    if (!imageUrl) return;
    const [rows] = await pool.execute<RowDataPacket[]>("SELECT COUNT(*) AS used FROM products WHERE image_url = ?", [imageUrl]);
    if (Number(rows[0].used) === 0) await deleteUploadedImage(imageUrl);
}

/* ---------- Tải ảnh lên ---------- */
// Nhận một file ảnh (trường "image"), lưu vào server/uploads/products và trả về địa chỉ để gắn vào thẻ.
// Đặt trước các đường dẫn có :id để chữ "image" không bị hiểu là một id.

const upload = multer({
    storage: multer.memoryStorage(), // giữ trong bộ nhớ để kiểm tra trước, ảnh không hợp lệ sẽ không bao giờ chạm vào đĩa
    limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
});

router.post("/image", (req, res) => {
    upload.single("image")(req, res, (error?: unknown) => {
        void (async () => {
            if (error) {
                if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
                    res.status(413).json({ message: "Ảnh quá lớn, tối đa 3 MB" });
                } else {
                    res.status(400).json({ message: "Không đọc được file tải lên" });
                }
                return;
            }

            const file = req.file;
            if (!file) {
                res.status(400).json({ message: "Chưa chọn ảnh" });
                return;
            }

            const extension = detectImageExtension(file.buffer);
            if (!extension) {
                res.status(415).json({ message: "Chỉ nhận ảnh JPG, PNG hoặc WebP" });
                return;
            }

            try {
                const imageUrl = await saveProductImage(file.buffer, extension);
                res.status(201).json({ imageUrl });
            } catch (saveError) {
                console.error("Lỗi lưu ảnh:", saveError);
                res.status(500).json({ message: "Không lưu được ảnh, vui lòng thử lại" });
            }
        })();
    });
});

/* ---------- Thêm thẻ ---------- */

router.post("/", async (req, res) => {
    const parsed = productSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ message: "Dữ liệu không hợp lệ", errors: collectErrors(parsed.error) });
        return;
    }

    const p = parsed.data;

    try {
        const [result] = await pool.execute<ResultSetHeader>(
            "INSERT INTO products (code, name, rarity, game, price, stock, image_url) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [p.code, p.name, p.rarity, p.game, p.price, p.stock, p.imageUrl],
        );

        const [rows] = await pool.execute<ProductRow[]>(`SELECT ${COLUMNS} FROM products WHERE id = ?`, [result.insertId]);
        res.status(201).json({ product: toProduct(rows[0]) });
    } catch (error) {
        if (isDuplicateProduct(error)) {
            res.status(409).json({ message: DUPLICATE_MESSAGE, errors: { code: DUPLICATE_MESSAGE } });
            return;
        }
        console.error("Lỗi thêm sản phẩm:", error);
        res.status(500).json({ message: "Lỗi máy chủ, vui lòng thử lại sau" });
    }
});

/* ---------- Sửa thẻ (kể cả thay ảnh) ---------- */

router.patch("/:id", async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) {
        res.status(400).json({ message: "ID không hợp lệ" });
        return;
    }

    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ message: "Dữ liệu không hợp lệ", errors: collectErrors(parsed.error) });
        return;
    }

    const entries = Object.entries(parsed.data).filter(([, value]) => value !== undefined);
    if (entries.length === 0) {
        res.status(400).json({ message: "Không có thông tin nào để cập nhật" });
        return;
    }

    try {
        const [existing] = await pool.execute<ProductRow[]>(`SELECT ${COLUMNS} FROM products WHERE id = ?`, [id]);
        const before: ProductRow | undefined = existing[0];
        if (!before) {
            res.status(404).json({ message: "Không tìm thấy sản phẩm" });
            return;
        }

        const assignments = entries.map(([key]) => `${COLUMN_OF[key]} = ?`);
        const values = entries.map(([, value]) => value as string | number);
        await pool.execute(`UPDATE products SET ${assignments.join(", ")} WHERE id = ?`, [...values, id]);

        const [rows] = await pool.execute<ProductRow[]>(`SELECT ${COLUMNS} FROM products WHERE id = ?`, [id]);
        const after = rows[0];

        // Đã thay ảnh khác thì dọn file ảnh cũ (nếu là ảnh tải lên và không thẻ nào còn dùng)
        if (after.image_url !== before.image_url) await removeImageIfUnused(before.image_url);

        res.json({ product: toProduct(after) });
    } catch (error) {
        if (isDuplicateProduct(error)) {
            res.status(409).json({ message: DUPLICATE_MESSAGE, errors: { code: DUPLICATE_MESSAGE } });
            return;
        }
        console.error("Lỗi cập nhật sản phẩm:", error);
        res.status(500).json({ message: "Lỗi máy chủ, vui lòng thử lại sau" });
    }
});

/* ---------- Xóa thẻ ---------- */

router.delete("/:id", async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) {
        res.status(400).json({ message: "ID không hợp lệ" });
        return;
    }

    try {
        const [existing] = await pool.execute<ProductRow[]>(`SELECT ${COLUMNS} FROM products WHERE id = ?`, [id]);
        const product: ProductRow | undefined = existing[0];
        if (!product) {
            res.status(404).json({ message: "Không tìm thấy sản phẩm" });
            return;
        }

        await pool.execute("DELETE FROM products WHERE id = ?", [id]);
        await removeImageIfUnused(product.image_url);

        res.json({ ok: true });
    } catch (error) {
        console.error("Lỗi xóa sản phẩm:", error);
        res.status(500).json({ message: "Lỗi máy chủ, vui lòng thử lại sau" });
    }
});

export default router;
