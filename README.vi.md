# Browser LLM Broker (Tiếng Việt)

Cho phép **Claude (MCP), REST API, dashboard hoặc lịch hẹn giờ** làm việc với **ChatGPT thông qua các Chrome bạn đã đăng nhập sẵn**, và nhận lại văn bản có định dạng, công thức toán, ảnh. Kết quả có thể gửi sang **Telegram** hoặc **webhook** bất kỳ.

- Một server nhỏ tự host (*broker*) giữ hàng đợi công việc; extension Chrome trên mỗi trình duyệt nhận việc, điều khiển chatgpt.com trong phiên đăng nhập của chính bạn rồi trả kết quả.
- Một người có thể ghép nhiều Chrome; cả nhóm dùng chung một broker (mỗi người chỉ dùng Chrome của mình).

> ⚠️ **Không chính thức, không liên kết với OpenAI.** Tự động hoá giao diện web chatgpt.com có thể trái điều khoản sử dụng của OpenAI và có thể khiến tài khoản bị giới hạn hoặc khoá. Đọc kỹ phần [Tuyên bố miễn trừ](README.md#disclaimer-read-this) (tiếng Anh) và mục 8 trong hướng dẫn trước khi dùng.

## Bắt đầu nhanh

```bash
git clone https://github.com/mrsiu226/browser-llm-broker.git
cd browser-llm-broker/broker
cp .env.example .env     # sửa SECRET_KEY (openssl rand -hex 32), ADMIN_EMAIL, ADMIN_PASSWORD
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build broker
```

Mở http://127.0.0.1:8088 → đăng nhập admin → `/#docs` để tải extension → cài vào Chrome (Developer mode → Load unpacked) → **Devices → Add device** lấy mã ghép → nhập vào trang cài đặt extension → tạo job thử.

## Tài liệu

- **Hướng dẫn đầy đủ tiếng Việt (cài đặt, sử dụng, triển khai server, xử lý sự cố): [docs/vi/HUONG-DAN.md](docs/vi/HUONG-DAN.md)**
- Tài liệu kỹ thuật (tiếng Anh): [docs/](docs/) — API, kiến trúc, triển khai.
- Giấy phép: [MIT](LICENSE).
