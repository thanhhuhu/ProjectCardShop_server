-- Tính năng thêm: hồ sơ, đánh giá, yêu thích, mã giảm giá, báo còn hàng lại.
-- Chạy MỘT LẦN cho MỌI database (cài mới lẫn đang chạy), sau schema.sql + orders.sql + blog.sql.
-- Đây là nơi DUY NHẤT thêm các cột/bảng của nhóm tính năng này.
-- Nếu một câu ALTER báo "Duplicate column"/"Duplicate key", nghĩa là đã chạy rồi — bỏ qua câu đó.

USE card_shop;

-- 1) Hồ sơ: lưu sẵn thông tin giao hàng để lần sau khỏi nhập lại
ALTER TABLE users ADD COLUMN full_name VARCHAR(120) NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN phone VARCHAR(30) NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN city VARCHAR(120) NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN address VARCHAR(255) NOT NULL DEFAULT '';

-- 2) Mã giảm giá áp vào đơn hàng
ALTER TABLE orders ADD COLUMN discount_code VARCHAR(40) NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN discount_amount INT UNSIGNED NOT NULL DEFAULT 0;

-- 3) Đánh giá sản phẩm (mỗi người 1 đánh giá / 1 thẻ, admin duyệt mới hiện)
CREATE TABLE IF NOT EXISTS product_reviews (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    product_id BIGINT UNSIGNED NOT NULL,
    user_id BIGINT UNSIGNED NOT NULL,
    rating TINYINT UNSIGNED NOT NULL,
    comment VARCHAR(2000) NOT NULL DEFAULT '',
    status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT uq_review_user_product UNIQUE (product_id, user_id),
    INDEX idx_review_product_status (product_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4) Yêu thích / wishlist
CREATE TABLE IF NOT EXISTS wishlists (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,
    product_id BIGINT UNSIGNED NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_wishlist_user_product UNIQUE (user_id, product_id),
    INDEX idx_wishlist_user (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5) Mã giảm giá
CREATE TABLE IF NOT EXISTS discount_codes (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(40) NOT NULL,
    discount_type ENUM('percent','amount') NOT NULL,
    value INT UNSIGNED NOT NULL,            -- percent: 1..100 ; amount: số tiền (đồng)
    min_order INT UNSIGNED NOT NULL DEFAULT 0,
    max_uses INT UNSIGNED NULL,             -- NULL = không giới hạn lượt dùng
    used_count INT UNSIGNED NOT NULL DEFAULT 0,
    active TINYINT(1) NOT NULL DEFAULT 1,
    expires_at DATETIME NULL,               -- NULL = không hết hạn
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_discount_code UNIQUE (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6) Báo còn hàng lại: khách để email cho thẻ đang hết hàng
CREATE TABLE IF NOT EXISTS stock_notifications (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    product_id BIGINT UNSIGNED NOT NULL,
    email VARCHAR(255) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_stock_notify UNIQUE (product_id, email),
    INDEX idx_stock_notify_product (product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
