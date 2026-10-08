# Browser LLM Broker — Hướng dẫn đầy đủ

Hệ thống cho phép **Claude, API hoặc lịch hẹn giờ** gửi yêu cầu (tạo ảnh / hỏi đáp) tới ChatGPT thông qua **trình duyệt Chrome của chính bạn** (đã đăng nhập ChatGPT), rồi nhận lại **văn bản có định dạng, công thức toán và ảnh**. Thiết kế cho nội bộ công ty (~20 người, mỗi người vài Chrome).

---

## 1. Tổng quan

```
Claude (MCP) ─┐
REST API ─────┼─▶  BROKER (server, Docker)  ◀── WebSocket ──  Extension trong Chrome ──▶ chatgpt.com
Dashboard ────┤        │  (SQLite + ảnh)                       (mỗi Chrome = 1 "thiết bị")
Lịch hẹn giờ ─┘        └──▶ Telegram (gửi kết quả)
```

- **Broker**: server trung tâm. Lưu người dùng, thiết bị, công việc, lịch; giao việc cho đúng Chrome của đúng người.
- **Extension**: cài trong Chrome. Mở chatgpt.com, điền prompt, đợi ChatGPT trả lời, lấy văn bản/ảnh gửi về broker.
- **Thiết bị (device)**: một Chrome profile đã cài extension và đã ghép với tài khoản trên broker. Một người có thể có nhiều thiết bị (dưới 5).
- Server **không bao giờ** tự nói chuyện với ChatGPT; mọi thứ chạy trên Chrome của người dùng.

Các thư mục:

| Thư mục | Nội dung |
|---|---|
| `broker/` | Server production (Docker), dashboard trong `broker/public/` |
| `extension/` | Extension Chrome (cài cho mọi thiết bị) |
| `docs/` | Tài liệu (tiếng Anh ở `docs/`, tiếng Việt ở `docs/vi/`) |

---

## 2. Yêu cầu

- Máy chủ có **Docker + Docker Compose** (VPS Linux, hoặc máy Mac/PC để thử).
- Mỗi người dùng: **Google Chrome**, đã **đăng nhập chatgpt.com**, tài khoản ChatGPT có quyền tạo ảnh (nếu cần ảnh).
- Chrome phải **đang mở** (và máy không ngủ) thì việc mới chạy được.
- Muốn dùng qua Claude: **Claude Code CLI** (`claude`).

---

## 3. Chạy thử trên máy cá nhân (không cần tên miền)

```bash
cd broker
cp .env.example .env
# mở .env và sửa: SECRET_KEY, ADMIN_EMAIL, ADMIN_PASSWORD
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build broker
```

- Dashboard: **http://127.0.0.1:8088** (file `docker-compose.local.yml` mở cổng 8088 và tắt cookie bảo mật vì không có HTTPS).
- Đăng nhập bằng `ADMIN_EMAIL` / `ADMIN_PASSWORD` trong `.env` (tài khoản admin chỉ được tạo **một lần** khi cơ sở dữ liệu còn trống; đổi mật khẩu sau đó bằng chức năng đổi mật khẩu trong dashboard).
- Nếu bỏ trống `ADMIN_PASSWORD`, mật khẩu ngẫu nhiên được in ra log: `docker compose logs broker`.

---

## 4. Cài extension và ghép thiết bị (mỗi Chrome làm một lần)

1. Mở `chrome://extensions` → bật **Developer mode** → **Load unpacked** → chọn thư mục `extension/`.
2. Đăng nhập **https://chatgpt.com** trong đúng Chrome profile này.
3. Trên dashboard: **Devices → Add device** → được một mã dạng `ABCD-1234` (hiệu lực 10 phút, dùng một lần).
4. Mở trang cài đặt extension (tự mở khi cài lần đầu, hoặc bấm biểu tượng extension). Nhập:
   - **Server URL**: địa chỉ broker (ví dụ `https://broker.congty.com`, hoặc `http://127.0.0.1:8088` khi thử).
   - **Pairing code**: mã vừa lấy.
   - **Tên** gợi nhớ (ví dụ "Laptop công ty").
5. Bấm **Connect**. Biểu tượng extension hiện **ON** nghĩa là đã kết nối; thiết bị xuất hiện trong dashboard ở trạng thái *online*.

Trạng thái trên biểu tượng: **ON** kết nối tốt · **OFF** mất kết nối (tự thử lại mỗi 2 giây) · **AUTH** token bị từ chối (hãy ghép lại).

Trang cài đặt extension hiện trạng thái kết nối trực tiếp, có nút **Reconnect now** và ô chọn cách chạy job: **chạy ngầm trong tab nền** (mặc định, Chrome không nhảy lên trước; nếu ChatGPT không nhận prompt ở tab nền thì job tự thử lại một lần ở chế độ trước mặt) hoặc **đưa Chrome lên trước**. Từ phiên bản 0.3.3 extension tự nối lại khi Chrome khởi động.

**Thiết bị offline:** mở trang cài đặt extension → *Reconnect now*; nếu token hỏng, trong **Devices** bấm **Re-pair** trên thẻ thiết bị để lấy mã mới (Chrome đó bấm *Disconnect this browser* rồi nhập lại URL + mã) — giữ nguyên tên, tag, lịch sử.

Đổi tên / gắn nhãn (tag) / tạm dừng / xóa thiết bị trong dashboard. Xóa thiết bị = thu hồi token ngay.

**Phân phối extension cho nhiều người:** gửi cho họ đường dẫn `https://<DOMAIN>/#docs` (có nút tải zip và hướng dẫn "Load unpacked"). Muốn tự động cập nhật, cân nhắc đăng lên Chrome Web Store ở chế độ *unlisted* (không công khai) hoặc dùng chính sách quản lý Chrome của công ty; lúc đó mỗi lần cập nhật không cần cài lại thủ công.

---

## 5. Cách sử dụng

### 5.1 Dashboard

- **Devices**: xem trạng thái các Chrome (online, offline, paused, limited = hết hạn mức ChatGPT).
- **Jobs → New job**: nhập prompt, chọn *Mode*, thiết bị đích, (tuỳ chọn) URL cuộc trò chuyện có sẵn. Các lựa chọn của lần trước được nhớ trong trình duyệt. Mở một job để xem kết quả: văn bản được hiển thị đúng định dạng (tiêu đề, danh sách, bảng, code, công thức), ảnh, nhật ký tiến trình (ở cuối trang). Khung **Continue this conversation** cho phép hỏi tiếp trong cùng cuộc trò chuyện ChatGPT khi job đã có kết quả (bị khoá lúc job đang chạy); nút **Delete** xoá job.
- **Schedules**: tạo lịch hằng ngày hoặc lặp mỗi N phút, gửi kết quả sang Telegram.
- **Channels**: khai báo bot Telegram (token + chat id) và thử gửi.
- **API keys**: tạo khoá cho REST/MCP. **Khoá chỉ hiện một lần** — hãy copy ngay.
- **Admin** (chỉ admin): tạo/khoá/xoá người dùng, xem thống kê.

**Mode**:

| Mode | Ý nghĩa |
|---|---|
| `image` | Chờ ChatGPT tạo ảnh. Nếu không có ảnh thì báo lỗi |
| `text` | Chỉ lấy văn bản trả lời |
| `auto` | Có ảnh do ChatGPT tạo thì lấy ảnh (kèm văn bản), không thì lấy văn bản |

Ảnh minh hoạ lấy từ web do ChatGPT chèn trong câu trả lời **không** được tính là "ảnh tạo ra".

### 5.2 Dùng với Claude (MCP)

1. Tạo API key trong dashboard.
2. Đăng ký (thay URL và key):
   ```bash
   claude mcp add --scope user --transport http llm-broker https://broker.congty.com/mcp \
     --header "Authorization: Bearer ck_XXXXXXXX"
   ```
3. Mở **phiên Claude mới** (hoặc `/mcp` → Reconnect). Các tool: `generate_image`, `ask_chatgpt`, `get_job`, `list_devices`.
4. Ví dụ nói với Claude:
   - "Dùng generate_image vẽ con trâu đang tắm suối."
   - "Dùng ask_chatgpt mode text hỏi: …, in nguyên văn kết quả, không tóm tắt."
   - "Dùng ask_chatgpt trên thiết bị *Home PC* hỏi …" (xem mục 5.4).

Các tool mới: `continue_chat` (hỏi tiếp trong cùng cuộc trò chuyện của một job; mỗi kết quả kèm `[job id: …]`) và `list_channels`; `generate_image`/`ask_chatgpt`/`continue_chat` có tham số `channel` (tên hoặc id kênh Telegram/webhook) để gửi thêm kết quả sang kênh đó. Ví dụ: "Dùng ask_chatgpt hỏi …, gửi kết quả vào kênh *Team Telegram*."

Tool chờ tối đa ~90 giây. Việc lâu hơn sẽ trả về mã job để gọi `get_job` lấy kết quả sau.

> Claude có thể tự **rút gọn** kết quả khi hiển thị cho bạn. Muốn nguyên văn, hãy yêu cầu "in nguyên văn", hoặc dùng REST/lịch Telegram (không qua Claude).

### 5.3 REST API

Header: `Authorization: Bearer ck_...`

```bash
# Gửi và chờ tối đa 120 giây, kèm ảnh dạng base64
curl -s -X POST "https://HOST/v1/jobs?wait=120&inline=1" \
  -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"prompt":"Giải thích định lý Pythagore, có công thức","mode":"text"}'
```

| Endpoint | Mô tả |
|---|---|
| `POST /v1/jobs` | Tạo job. Body: `prompt`, `mode`, `conversationUrl?`, `target?`, `timeoutMs?`. Không có `wait` → trả `202 {id}` |
| `GET /v1/jobs/:id` | Xem trạng thái/kết quả (`state`, `text`, `markdown`, `images[]`) |
| `POST /v1/jobs/:id/cancel` | Huỷ |
| `POST /v1/jobs/:id/followup` | Hỏi tiếp trong cùng cuộc trò chuyện (body `prompt`, `mode?`, `channelId?`, hỗ trợ `?wait=`) |
| `DELETE /v1/jobs/:id` | Xoá job và kết quả |
| `GET /v1/devices` | Danh sách thiết bị của bạn |

Kết quả có `text` (văn bản thuần) và `markdown` (đầy đủ định dạng, công thức `$...$` / `$$...$$`). `images[].url` là link có chữ ký, hết hạn sau 1 giờ.

### 5.4 Chọn Chrome nào trả lời

- REST: `"target": {"device": "Laptop công ty"}` (tên hoặc id, không phân biệt hoa thường) hoặc `"target": {"tag": "art"}`.
- MCP: tham số `device` / `tag` của tool; `list_devices` liệt kê tên và trạng thái.
- Dashboard: ô *Target Device* / *Target Tag*.
- Không chỉ định → thiết bị rảnh, online, lâu chưa dùng nhất của **chính bạn** (không bao giờ dùng Chrome của người khác).
- Thiết bị chỉ định đang offline/bận/tạm dừng/hết hạn mức → việc chờ trong hàng đợi (tối đa 10 phút) rồi báo lỗi.

### 5.5 Lịch hẹn giờ và Telegram

1. Tạo bot qua **@BotFather** (lấy token). Nhắn cho bot một tin, rồi mở `https://api.telegram.org/bot<TOKEN>/getUpdates` để lấy `chat id`.
2. Dashboard → **Channels** → thêm kênh Telegram → **Test**.
3. Dashboard → **Schedules** → tạo lịch:
   - *Daily* (giờ cố định) hoặc *Interval* (mỗi N phút, tuỳ chọn khung giờ hoạt động).
   - Prompt + (tuỳ chọn) URL cuộc trò chuyện sẵn có → ChatGPT nhớ ngữ cảnh/memory của cuộc trò chuyện đó.
   - Với văn bản: *Bỏ qua nếu không đổi* và *Bỏ qua nếu khớp regex* (ví dụ `no new data|không có dữ liệu mới`) để tránh spam.
4. Kết quả gửi sang Telegram (ảnh, văn bản có định dạng). Lỗi cũng được báo bằng tin ⚠️.

### 5.6 Gửi kết quả ra API bên thứ ba (Webhook)

Ngoài Telegram, **Channels → Add Channel → External API (webhook)** cho phép gửi kết quả của job/lịch tới một API bất kỳ (Slack, Discord, Zapier, n8n, hệ thống nội bộ…).

Cấu hình kênh webhook:

| Trường | Ý nghĩa |
|---|---|
| Endpoint URL | Địa chỉ nhận (http/https) |
| Method | POST (mặc định), PUT hoặc PATCH |
| Custom headers | Mỗi dòng `Tên: giá trị` (ví dụ `Authorization: Bearer xxx`). Giá trị được mã hoá khi lưu và không hiển thị lại; để trống khi sửa = giữ nguyên |
| Signing secret | Tuỳ chọn, để bên nhận xác minh chữ ký (xem dưới) |
| Images in payload | `Links` (link có chữ ký, hiệu lực 7 ngày — cần đặt `BASE_URL`/`DOMAIN` đúng), `base64` (nhúng ảnh) hoặc `None` |
| Custom body template | Tuỳ chọn, để khớp định dạng của API đích (ví dụ Slack: `{"text": "{{markdown}}"}`) |

Dùng kênh ở đâu: trong **Schedule** (ô *Send to*) hoặc trong **New job** (ô *Also send the result to*); qua REST thêm `"channelId": "<id kênh>"` vào `POST /v1/jobs`. Nút **Test** gửi thử một gói mẫu (`event: "channel.test"`).

Gói JSON chuẩn (khi không dùng template):

```json
{
  "event": "job.finished",
  "sentAt": "2026-10-06T10:00:00Z",
  "job": { "id": "...", "state": "succeeded", "mode": "auto", "prompt": "...", "error": null,
           "source": "schedule", "createdAt": "...", "finishedAt": "...", "device": "Laptop công ty" },
  "schedule": { "id": "...", "name": "daily-art" },
  "result": { "text": "...", "markdown": "...",
              "images": [ { "mime": "image/png", "url": "https://.../files/...?exp=..&sig=.." } ] }
}
```

- `job.state` là `succeeded`, `failed` hoặc `canceled`; khi lỗi, `job.error` có thông báo (webhook vẫn được gọi để bên nhận biết).
- Template: `{{text}} {{markdown}} {{prompt}} {{error}} {{state}} {{jobId}} {{scheduleName}} {{event}}` (tự escape cho JSON) và `{{json}}` (cả gói).
- Header gửi kèm: `X-Broker-Event`; nếu có secret thì thêm `X-Broker-Timestamp` và `X-Broker-Signature: sha256=<HMAC-SHA256(secret, timestamp + "." + body)>`. Bên nhận nên kiểm tra chữ ký và chặn timestamp quá cũ.
- Thất bại (mạng lỗi, 5xx, 429) được thử lại tối đa 3 lần (cách 2 giây, 10 giây); lỗi 4xx và chuyển hướng (3xx) không thử lại. Kết quả giao hàng của **lịch** hiện ở cột trạng thái cuối của Schedule.
- **Bảo vệ SSRF**: server từ chối địa chỉ nội bộ (127.0.0.1, 10.x, 172.16–31.x, 192.168.x, 169.254.x, localhost…). Nếu API đích nằm trong mạng nội bộ công ty, đặt `WEBHOOK_ALLOW_PRIVATE=1` trong `.env` (chỉ làm khi bạn tin tưởng mọi người dùng).

Lưu ý: lịch cần có ít nhất một Chrome của bạn đang online; nếu không, việc chờ tối đa 30 phút rồi báo lỗi. Lịch hằng ngày chạy bù trong 120 phút nếu server bị lỡ giờ.

---

## 6. Triển khai lên server (production)

Ví dụ cho một VPS Ubuntu 22.04/24.04 (1 vCPU, 1–2 GB RAM là đủ cho ~20 người).

### 6.1 Chuẩn bị

1. **Tên miền** (ví dụ `broker.congty.com`) trỏ bản ghi **A** về IP của VPS.
2. Cài Docker:
   ```bash
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker $USER   # đăng xuất/đăng nhập lại
   ```
3. Tường lửa — chỉ mở SSH và web, **không** mở cổng 8080:
   ```bash
   sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable
   ```

### 6.2 Đưa mã lên server và cấu hình

```bash
git clone https://github.com/mrsiu226/browser-llm-broker.git
cd browser-llm-broker/broker
cp .env.example .env
nano .env
```

> Image Docker được build từ **thư mục gốc của repo** (để đóng gói cả `extension/` cho người dùng tải về), nên hãy giữ nguyên cấu trúc thư mục và chạy `docker compose` trong `broker/`. Nếu bạn không dùng git, chép cả `broker/` và `extension/` lên server (bỏ `node_modules`, `dist`, `data`, `.env`).

Các biến trong `.env`:

| Biến | Giá trị gợi ý |
|---|---|
| `SECRET_KEY` | Chuỗi ngẫu nhiên dài: `openssl rand -hex 32`. Dùng để mã hoá token Telegram và ký link ảnh. **Mất khoá này thì các kênh Telegram đã lưu không đọc được nữa → hãy sao lưu** |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Admin đầu tiên (chỉ tạo khi CSDL trống) |
| `DOMAIN` | Tên miền, ví dụ `broker.congty.com` (Caddy dùng để tự cấp HTTPS) |
| `COOKIE_SECURE` | `1` (khi có HTTPS) |
| `TRUST_PROXY` | `1` (khi phía trước có Caddy/nginx) |
| `RETENTION_DAYS` | Số ngày giữ job/ảnh (mặc định 14) |
| `BASE_URL` | Địa chỉ công khai (mặc định `https://<DOMAIN>`), dùng tạo link ảnh gửi qua webhook |
| `WEBHOOK_ALLOW_PRIVATE` | `1` để cho phép webhook tới địa chỉ nội bộ (mặc định chặn) |
| `MCP_WAIT_MS`, `QUEUE_TIMEOUT_MS`, `CATCH_UP_MINUTES` | Tuỳ chọn, xem `.env.example` |

> **Không** commit `.env` lên git.

### 6.3 Chạy

```bash
docker compose up -d --build
docker compose logs -f broker      # xem log; Ctrl+C để thoát
```

Caddy tự xin chứng chỉ HTTPS (cần DNS đã trỏ đúng và cổng 80/443 mở). Mở `https://<DOMAIN>` và đăng nhập admin.

Nếu bạn đã có reverse proxy riêng (nginx/Traefik): bỏ service `caddy` trong `docker-compose.yml`, proxy tới `broker:8080`, **bắt buộc bật WebSocket** (đường `/ws`) và đặt `TRUST_PROXY=1`. Ví dụ nginx:

```nginx
location / {
  proxy_pass http://127.0.0.1:8080;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_read_timeout 3600s;
}
```
(Khi đó cần publish cổng 8080 vào `127.0.0.1` trong compose.)

### 6.4 Trang hướng dẫn và tải extension cho người dùng

- Trang hướng dẫn công khai (không cần đăng nhập): **`https://<DOMAIN>/#docs`** — có sẵn mục lục, lệnh cài đặt tự điền đúng địa chỉ server và nút **Tải extension (.zip)**. Nội dung nằm trong `broker/public/docs.md` (sửa file này rồi build lại để cập nhật; `{{ORIGIN}}` được tự thay bằng địa chỉ server).
- File zip extension được tạo tự động từ thư mục `extension/` đi kèm image: **`https://<DOMAIN>/download/extension.zip`** (thông tin phiên bản: `/download/extension.json`). Khi bạn sửa extension, chạy lại `docker compose up -d --build` là zip mới được phát hành; người dùng tải lại, giải nén đè và tải lại extension trong `chrome://extensions`.

Chỉ cần gửi cho mọi người đường dẫn `https://<DOMAIN>/#docs`.

### 6.5 Sau khi triển khai

1. Đăng nhập admin → **Admin → Add User** tạo tài khoản cho từng người (họ tự đổi mật khẩu sau).
2. Mỗi người cài extension, ghép thiết bị (mục 4) với **Server URL = `https://<DOMAIN>`**.
3. Mỗi người tạo API key riêng nếu dùng Claude/REST.

### 6.6 Vận hành

| Việc | Lệnh |
|---|---|
| Xem trạng thái | `docker compose ps` |
| Xem log | `docker compose logs -f broker` |
| Khởi động lại | `docker compose restart broker` |
| Cập nhật phiên bản mới | cập nhật mã, rồi `docker compose up -d --build` (CSDL tự nâng cấp cấu trúc, dữ liệu giữ nguyên) |
| Dừng | `docker compose down` (dữ liệu vẫn còn trong volume) |

**Sao lưu** (dữ liệu = CSDL SQLite + ảnh nằm trong volume Docker). Kiểm tra tên volume bằng `docker volume ls` (thường là `broker_broker-data`):

```bash
docker compose stop broker
docker run --rm -v broker_broker-data:/data -v $PWD:/backup busybox tar czf /backup/broker-data-$(date +%F).tgz -C /data .
docker compose start broker
```
Hãy sao lưu thêm file `.env` (đặc biệt `SECRET_KEY`) ở nơi an toàn, tách khỏi bản sao lưu dữ liệu. Khôi phục: giải nén ngược vào volume khi broker đang dừng.

### 6.7 Bảo mật

- Luôn dùng **HTTPS** (Caddy làm sẵn); đặt `COOKIE_SECURE=1`.
- Mật khẩu người dùng được băm (scrypt); API key và token thiết bị chỉ lưu dạng băm; token Telegram được mã hoá bằng `SECRET_KEY`.
- Có giới hạn số lần đăng nhập sai và số lần thử mã ghép.
- Khoá/xoá người dùng hoặc xoá thiết bị có hiệu lực ngay.
- Máy chủ **nhìn thấy** nội dung hỏi đáp (vì nó chuyển tiếp). Hãy đặt `RETENTION_DAYS` phù hợp chính sách công ty và chỉ cho người đáng tin cậy làm admin/quản trị server.
- Extension chỉ thực hiện một bộ lệnh cố định trên chatgpt.com; server không thể chạy mã tuỳ ý trong trình duyệt của bạn.

---

## 7. Xử lý sự cố

| Triệu chứng | Nguyên nhân / cách xử lý |
|---|---|
| Extension báo **OFF** | Sai Server URL, server tắt, hoặc proxy chưa bật WebSocket. Kiểm tra `curl https://HOST/healthz` (phải trả `{"ok":true}`) |
| Extension báo **AUTH** | Thiết bị đã bị xoá hoặc token sai → Disconnect rồi ghép lại bằng mã mới |
| Ghép mã báo "invalid or expired" | Mã hết hạn (10 phút) hoặc đã dùng → tạo mã mới |
| Không đăng nhập được dashboard | Kiểm tra email/mật khẩu trong `.env`; nhiều lần sai sẽ bị khoá tạm 15 phút. Cổng/địa chỉ có thể bị chương trình khác chiếm — dùng đúng cổng 8088 (thử local) hoặc tên miền (production) |
| Job nằm ở *queued* mãi | Không có thiết bị online/rảnh (Chrome tắt, thiết bị paused/limited, hoặc sai target). Quá 10 phút sẽ báo lỗi |
| Lỗi *usage limit reached* | Tài khoản ChatGPT hết hạn mức tạo ảnh; thiết bị được đánh dấu *limited* đến giờ đặt lại, việc sẽ chuyển sang Chrome khác của bạn nếu có |
| Text trả về rỗng hoặc là câu thông báo | ChatGPT chưa trả lời xong hoặc giao diện đổi; thử lại. Nếu lặp lại, giao diện ChatGPT có thể đã thay đổi (cần cập nhật extension) |
| Ảnh không lấy được (mode `image`) | Ảnh không phải do ChatGPT tạo, hoặc bị chặn; ở mode `auto` hệ thống trả văn bản thay vì lỗi |
| Telegram không nhận | Dùng nút **Test** ở Channels; kiểm tra token/chat id và bot đã được bạn nhắn tin trước |
| Quên `SECRET_KEY` / mất file `.env` | Kênh Telegram cũ không giải mã được → xoá và tạo lại kênh |
| Chrome ngủ / máy tính ngủ | Việc không chạy được. Trên Mac có thể dùng `caffeinate -s` hoặc tắt chế độ ngủ khi cắm điện |

---

## 8. Giới hạn và lưu ý quan trọng

- **Điều khoản ChatGPT**: tự động hoá giao diện web ChatGPT có thể trái điều khoản sử dụng của OpenAI; tài khoản có thể bị giới hạn hoặc khoá. Chỉ dùng tài khoản **của chính từng người** trên trình duyệt của họ, có sự đồng ý; **không** gộp chung hay chia sẻ tài khoản.
- **Giao diện ChatGPT hay thay đổi**: extension dựa vào cấu trúc trang; khi ChatGPT đổi giao diện, một số chức năng có thể hỏng và cần cập nhật extension.
- Mỗi thiết bị chạy **một việc một lúc**; muốn nhanh hơn hãy thêm thiết bị.
- Hạn mức tạo ảnh của ChatGPT vẫn áp dụng cho mỗi tài khoản; lịch chạy dày đặc sẽ tiêu hạn mức rất nhanh.
- Ảnh và job tự xoá sau `RETENTION_DAYS` ngày.
- Chrome phải mở và đã đăng nhập ChatGPT thì mới có thiết bị *online*.

---

## 9. Giấy phép và đóng góp

- Mã nguồn dùng giấy phép **MIT** (xem `LICENSE`): được dùng, sửa, phân phối kể cả thương mại, miễn giữ nguyên thông báo bản quyền; **không có bảo hành**. Thành phần bên thứ ba: `THIRD_PARTY_NOTICES.md`.
- Dự án **không liên kết với OpenAI**; "ChatGPT", "OpenAI" là nhãn hiệu của OpenAI.
- Đóng góp (issue, pull request): xem `CONTRIBUTING.md`; báo lỗi bảo mật: `SECURITY.md`. Chạy `cd broker && npm ci && npm run build && npm test` trước khi gửi PR.
- Đổi khoá bí mật (`SECRET_KEY`) sau khi lộ: xem `docs/DEPLOYMENT.md` (mục *Rotating SECRET_KEY*), dùng lệnh `npm run rotate-secret`.
