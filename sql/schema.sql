-- Tạo bảng users và products. Chạy file này TRƯỚC, sau đó chạy orders.sql.
-- Dùng CREATE TABLE IF NOT EXISTS nên chạy trên database đã có sẵn bảng cũng không mất dữ liệu.
--
-- Lưu ý: code backend dựa vào TÊN của các ràng buộc UNIQUE bên dưới để báo lỗi trùng
-- (uq_users_username, uq_users_email trong utils.ts; uq_products_code_rarity trong adminProducts.ts).
-- Nếu database hiện tại đặt tên khác, lỗi trùng sẽ thành lỗi 500. Kiểm tra bằng:
--   SHOW INDEX FROM users;  SHOW INDEX FROM products;
-- và đổi tên nếu cần, ví dụ:
--   ALTER TABLE users RENAME INDEX email TO uq_users_email;

CREATE TABLE IF NOT EXISTS users (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50) NOT NULL,
    email VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role ENUM('user', 'admin') NOT NULL DEFAULT 'user',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_users_username UNIQUE (username),
    CONSTRAINT uq_users_email UNIQUE (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS products (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(50) NOT NULL,
    name VARCHAR(255) NOT NULL,
    archetype VARCHAR(100) NOT NULL DEFAULT '' COMMENT 'Tộc hệ, vd Trickstar',
    rarity VARCHAR(50) NOT NULL,
    game VARCHAR(50) NOT NULL,
    price INT UNSIGNED NOT NULL DEFAULT 0,
    stock INT UNSIGNED NOT NULL DEFAULT 0,
    image_url VARCHAR(500) NOT NULL DEFAULT '',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT uq_products_code_rarity UNIQUE (code, rarity),
    INDEX idx_products_game (game),
    INDEX idx_products_archetype (game, archetype)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tạo tài khoản admin đầu tiên: đăng ký bình thường trên web, rồi chạy:
--   UPDATE users SET role = 'admin' WHERE username = 'ten_tai_khoan_cua_ban';
