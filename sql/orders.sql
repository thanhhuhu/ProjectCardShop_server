-- Chạy file này trong phpMyAdmin của database card_shop.
-- Bảng users hiện tại của project phải tồn tại trước khi tạo orders.
-- user_id cố ý không tạo FOREIGN KEY để tránh lệch kiểu dữ liệu với users.id
-- nếu schema users của bạn đang dùng kiểu INT/BIGINT khác nhau.

CREATE TABLE IF NOT EXISTS orders (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(32) NOT NULL UNIQUE COMMENT 'Mã đơn hàng / nội dung chuyển khoản',
    user_id BIGINT UNSIGNED NULL,
    full_name VARCHAR(120) NOT NULL,
    phone VARCHAR(30) NOT NULL,
    email VARCHAR(255) NULL,
    city VARCHAR(120) NOT NULL,
    address VARCHAR(255) NOT NULL,
    note VARCHAR(1000) NULL,
    subtotal BIGINT UNSIGNED NOT NULL,
    shipping_fee BIGINT UNSIGNED NOT NULL DEFAULT 0,
    total_amount BIGINT UNSIGNED NOT NULL,
    payment_method ENUM('cod', 'bank') NOT NULL DEFAULT 'cod',
    payment_status ENUM('unpaid', 'paid', 'failed') NOT NULL DEFAULT 'unpaid',
    status ENUM('pending', 'confirmed', 'shipping', 'completed', 'cancelled') NOT NULL DEFAULT 'pending',
    paid_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_orders_user (user_id),
    INDEX idx_orders_payment (payment_status, created_at),
    INDEX idx_orders_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS order_items (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    order_id BIGINT UNSIGNED NOT NULL,
    product_id BIGINT UNSIGNED NOT NULL,
    product_code VARCHAR(100) NOT NULL,
    product_name VARCHAR(255) NOT NULL,
    rarity VARCHAR(100) NULL,
    unit_price BIGINT UNSIGNED NOT NULL,
    quantity INT UNSIGNED NOT NULL,
    line_total BIGINT UNSIGNED NOT NULL,
    image_url VARCHAR(1000) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_order_items_order (order_id),
    CONSTRAINT fk_order_items_order
        FOREIGN KEY (order_id) REFERENCES orders(id)
        ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payment_transactions (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    provider VARCHAR(32) NOT NULL,
    transaction_id VARCHAR(100) NOT NULL UNIQUE COMMENT 'ID giao dịch từ cổng/webhook',
    order_id BIGINT UNSIGNED NOT NULL,
    amount BIGINT UNSIGNED NOT NULL,
    account_number VARCHAR(50) NULL,
    content VARCHAR(1000) NULL,
    raw_payload JSON NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_payment_transactions_order (order_id),
    CONSTRAINT fk_payment_transactions_order
        FOREIGN KEY (order_id) REFERENCES orders(id)
        ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
