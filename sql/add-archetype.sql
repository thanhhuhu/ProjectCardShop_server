-- Thêm cột "tộc hệ" (archetype) cho bảng products và điền cho các thẻ đã có.
-- Chạy MỘT LẦN trên database đang chạy (cả máy local lẫn TiDB), sau khi đã có bảng products.
-- An toàn khi chạy lại: nếu cột đã tồn tại, câu ADD COLUMN sẽ báo lỗi "Duplicate column" — khi đó
-- bỏ qua câu đó và chỉ chạy phần UPDATE.

-- Chọn database (bỏ dòng này nếu editor đã trỏ sẵn vào database của bạn)
USE card_shop;

ALTER TABLE products ADD COLUMN archetype VARCHAR(100) NOT NULL DEFAULT '' COMMENT 'Tộc hệ, vd Trickstar';
ALTER TABLE products ADD INDEX idx_products_archetype (game, archetype);

-- Điền tộc hệ cho các thẻ cũ: lấy chữ đầu tiên trong tên thẻ (vd "Trickstar Lilybell" -> "Trickstar").
-- Sau đó admin có thể sửa lại từng thẻ cho đúng.
UPDATE products
SET archetype = TRIM(SUBSTRING_INDEX(name, ' ', 1))
WHERE archetype = '';
