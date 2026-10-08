# Hướng dẫn sử dụng Browser LLM Broker

Hệ thống cho phép bạn (hoặc Claude, hoặc một lịch hẹn giờ) gửi yêu cầu tới **ChatGPT thông qua chính trình duyệt Chrome của bạn**, rồi nhận lại **văn bản có định dạng, công thức toán và ảnh**. Kết quả có thể xem trên dashboard, lấy qua API/MCP hoặc tự động gửi sang Telegram / API khác.

## 1. Cài extension vào Chrome

Mỗi Chrome (mỗi profile) bạn muốn dùng cần cài extension một lần.

1. **Tải extension**: bấm nút **Tải extension (.zip)** ở đầu trang này, rồi **giải nén** (sẽ ra thư mục `browser-llm-broker-extension`). Hãy để thư mục ở chỗ cố định, đừng xoá sau khi cài.
2. Mở `chrome://extensions` trên Chrome, bật **Developer mode** (góc trên bên phải).
3. Bấm **Load unpacked** và chọn thư mục `browser-llm-broker-extension` vừa giải nén.
4. Mở **https://chatgpt.com** trong đúng Chrome này và **đăng nhập** tài khoản ChatGPT của bạn.

> Khi có phiên bản mới, tải zip mới, giải nén đè lên thư mục cũ rồi bấm biểu tượng tải lại (⟳) của extension trong `chrome://extensions`.

## 2. Ghép Chrome với tài khoản của bạn

1. Đăng nhập dashboard này, vào **Devices → Add device** để lấy mã dạng `ABCD-1234` (hiệu lực 10 phút, dùng một lần).
2. Mở trang cài đặt của extension (tự mở khi cài lần đầu, hoặc bấm biểu tượng extension). Nhập:
   - **Server URL**: `{{ORIGIN}}`
   - **Pairing code**: mã vừa lấy
   - **Tên** gợi nhớ cho Chrome này (ví dụ "Laptop công ty")
3. Bấm **Connect**. Biểu tượng extension hiện **ON** và thiết bị xuất hiện trong **Devices** với trạng thái *online*.

Trạng thái trên biểu tượng: **ON** đã kết nối · **OFF** mất kết nối (tự thử lại) · **AUTH** token bị từ chối, hãy ghép lại.

Một người có thể ghép nhiều Chrome. Đổi tên, gắn nhãn (tag), tạm dừng hoặc xoá thiết bị trong **Devices**.

**Trang cài đặt extension** (bấm biểu tượng extension) hiện trạng thái kết nối theo thời gian thực, có nút **Reconnect now** để nối lại thủ công, và ô chọn cách chạy job (xem bên dưới). Extension tự kết nối lại mỗi khi bạn mở Chrome (từ phiên bản 0.3.3).

**Thiết bị đang offline?**

- Chrome vừa mở lại hoặc mất mạng: mở trang cài đặt extension, bấm **Reconnect now**.
- Token hỏng/AUTH: trong **Devices**, bấm **Re-pair** trên thẻ thiết bị offline để lấy mã mới. Trên Chrome đó bấm **Disconnect this browser**, nhập Server URL + mã rồi **Connect**. Thiết bị giữ nguyên tên, tag và lịch sử, chỉ token được đổi.

**Điều kiện để việc chạy được:** Chrome đang mở, máy không ngủ, và đã đăng nhập chatgpt.com.

**Cách chạy job** (chọn trong trang cài đặt extension, ô *When a job runs*):

- **Chạy ngầm trong tab nền** (mặc định): Chrome không nhảy lên phía trước. Nếu ChatGPT không nhận prompt trong tab nền, job tự thử lại một lần với Chrome ở phía trước.
- **Đưa Chrome lên phía trước khi chạy**: ổn định hơn, nhưng cửa sổ Chrome sẽ hiện lên trong vài chục giây.

## 3. Tạo job trên dashboard

**Jobs → New job**:

- **Prompt**: nội dung gửi cho ChatGPT.
- **Mode**: `image` (chờ ảnh), `text` (chỉ lấy văn bản), `auto` (có ảnh do ChatGPT tạo thì lấy ảnh kèm văn bản, không thì lấy văn bản).
- **Existing Conversation URL** (tuỳ chọn): dán địa chỉ một cuộc trò chuyện cũ (`https://chatgpt.com/c/...`) để gửi tin vào đó và giữ nguyên ngữ cảnh/memory. Để trống = chat mới.
- **Target Device / Tag**: chọn Chrome nào chạy (mặc định: Chrome đang rảnh của bạn). Các lựa chọn được nhớ cho lần sau.
- **Also send the result to**: gửi kết quả sang một kênh (Telegram/webhook) khi xong.

Mở một job để xem kết quả: văn bản hiển thị đúng định dạng (tiêu đề, danh sách, bảng, code, công thức), ảnh, và nhật ký tiến trình (ở cuối trang).

**Tiếp tục cuộc trò chuyện:** khi job đã có kết quả, khung **Continue this conversation** mở khoá (trong lúc job còn chạy khung bị khoá). Gõ tin nhắn tiếp theo và bấm **Send**: tin được gửi vào đúng cuộc trò chuyện ChatGPT của job đó, như gõ tiếp trên chatgpt.com, và ưu tiên chạy trên đúng Chrome đã chạy job. Mỗi lần gửi tạo một job mới, có dòng "Follow-up of …" để quay lại job trước. Job tạo bằng chat tạm thời (không có địa chỉ cuộc trò chuyện) không tiếp tục được.

**Xoá job:** nút **Delete** ở danh sách Jobs và ở trang chi tiết (xoá cả kết quả và ảnh, không khôi phục được). Job đang chạy sẽ bị huỷ rồi xoá.

## 4. Lịch hẹn giờ (Schedules)

**Schedules → Create**:

- **Daily** (giờ cố định, theo múi giờ chọn) hoặc **Interval** (mỗi N phút, có thể giới hạn khung giờ).
- **Prompt** + (tuỳ chọn) **Existing Conversation URL**: mở cuộc trò chuyện cũ trên ChatGPT, copy địa chỉ trên thanh địa chỉ rồi dán vào. Prompt được gửi như một tin nhắn mới trong cuộc trò chuyện đó.
- **Run on device / tag**, **Mode**, **Notification Channel**.
- Với kết quả dạng văn bản: *bỏ qua nếu không đổi* và *bỏ qua nếu khớp regex* (ví dụ `no new data|không có dữ liệu mới`) để không bị gửi lặp.

Dùng nút **Run now** để thử ngay. Lịch cần có ít nhất một Chrome của bạn đang online; nếu không, việc chờ tối đa 30 phút rồi báo lỗi.

## 5. Kênh nhận kết quả (Channels)

**Telegram**: tạo bot qua `@BotFather` để lấy token; nhắn cho bot một tin, rồi mở `https://api.telegram.org/bot<TOKEN>/getUpdates` để lấy `chat id`. Thêm kênh, bấm **Test**.

**External API (webhook)**: gửi kết quả tới API bất kỳ.

- Cấu hình: URL, method (POST/PUT/PATCH), header tuỳ chỉnh (ví dụ `Authorization: Bearer ...`), secret ký HMAC (tuỳ chọn), ảnh gửi dạng link hoặc base64, body template tuỳ chỉnh.
- Gói JSON chuẩn: `event`, `job` (id, state, prompt, error...), `schedule`, `result.text`, `result.markdown`, `result.images[]`.
- Template dùng được `{{text}} {{markdown}} {{prompt}} {{error}} {{state}} {{jobId}} {{scheduleName}} {{event}}` và `{{json}}`.
- Có header `X-Broker-Event`; nếu đặt secret còn có `X-Broker-Timestamp` và `X-Broker-Signature: sha256=HMAC(secret, timestamp + "." + body)`.
- Tự thử lại tối đa 3 lần khi lỗi mạng/5xx. Địa chỉ nội bộ bị chặn mặc định.

## 6. Dùng với Claude (MCP)

1. Vào **API Keys → Create** và **copy ngay** khoá (chỉ hiện một lần).
2. Chạy lệnh (thay `ck_XXXX` bằng khoá của bạn):

```
claude mcp add --scope user --transport http llm-broker {{ORIGIN}}/mcp --header "Authorization: Bearer ck_XXXX"
```

3. Mở **phiên Claude mới** (hoặc `/mcp` → Reconnect). Các tool: `generate_image`, `ask_chatgpt`, `continue_chat`, `get_job`, `list_devices`, `list_channels`.

Ví dụ nói với Claude:

- "Dùng generate_image vẽ con trâu đang tắm suối."
- "Dùng ask_chatgpt mode text hỏi: …, in nguyên văn kết quả, không tóm tắt."
- "Dùng ask_chatgpt trên thiết bị *Laptop công ty* hỏi …" (tham số `device`, hoặc `tag`).
- "Dùng ask_chatgpt hỏi …, gửi kết quả vào kênh *Team Telegram*." (tham số `channel`: tên hoặc id kênh; `list_channels` liệt kê các kênh của bạn).
- "Dùng continue_chat với job id … hỏi tiếp: …" — gửi tin tiếp theo vào cùng cuộc trò chuyện ChatGPT. Mỗi kết quả có kèm dòng `[job id: …]` để dùng cho việc này.

Tool chờ tối đa khoảng 90 giây; việc lâu hơn trả về mã job để gọi `get_job` sau. Claude có thể tự rút gọn kết quả khi hiển thị; muốn nguyên văn hãy yêu cầu "in nguyên văn".

## 7. REST API

Header: `Authorization: Bearer ck_...`

```
curl -s -X POST "{{ORIGIN}}/v1/jobs?wait=120&inline=1" \
  -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"prompt":"Giải thích định lý Pythagore, có công thức","mode":"text"}'
```

- `POST /v1/jobs`: body `prompt`, `mode`, `conversationUrl?`, `target?` (`{"device":"tên hoặc id"}` hoặc `{"tag":"..."}`), `channelId?` (id hoặc tên kênh nhận kết quả), `timeoutMs?`. Không có `wait` → trả `202 {id}`.
- `GET /v1/jobs/:id`: trạng thái và kết quả (`text`, `markdown`, `images[]`).
- `POST /v1/jobs/:id/followup`: gửi tin tiếp theo vào cuộc trò chuyện của job đó. Body `prompt`, `mode?`, `channelId?`; hỗ trợ `?wait=` như `POST /v1/jobs`.
- `POST /v1/jobs/:id/cancel`: huỷ. `DELETE /v1/jobs/:id`: xoá job và kết quả.
- `GET /v1/devices`: danh sách thiết bị của bạn.

## 8. Xử lý sự cố

- **Extension báo OFF / thiết bị offline**: sai Server URL, server không truy cập được, hoặc Chrome vừa mở lại. Thử mở `{{ORIGIN}}/healthz`, rồi bấm **Reconnect now** trong trang cài đặt extension (cập nhật extension lên bản mới nhất để tự nối lại khi mở Chrome).
- **Extension báo AUTH**: token không còn hiệu lực → dùng **Re-pair** (xem mục 2) hoặc Disconnect rồi ghép lại bằng mã mới.
- **Job nằm ở *queued***: không có Chrome nào online/rảnh (hoặc thiết bị đang tạm dừng/hết hạn mức). Quá 10 phút sẽ báo lỗi.
- **"Prompt was not sent to ChatGPT"**: cửa sổ Chrome đang bị thu nhỏ/ẩn, hoặc trang ChatGPT chưa sẵn sàng. Để Chrome mở (không thu nhỏ) hoặc đổi sang chế độ "Bring Chrome to the front" trong cài đặt extension, rồi thử lại.
- **"Usage limit reached"**: tài khoản ChatGPT hết hạn mức tạo ảnh; Chrome đó được đánh dấu *limited* đến giờ đặt lại, việc chuyển sang Chrome khác của bạn nếu có.
- **Văn bản trống/lạ hoặc ảnh không lấy được**: giao diện ChatGPT có thể đã đổi; báo quản trị viên để cập nhật extension.

## 9. Lưu ý

- Chỉ dùng tài khoản ChatGPT **của chính bạn** trên trình duyệt của bạn; **không** chia sẻ hay gộp tài khoản. Tự động hoá giao diện web có thể trái điều khoản sử dụng của OpenAI.
- Máy chủ chuyển tiếp nên nhìn thấy nội dung hỏi đáp; job và ảnh tự xoá sau một số ngày.
- Mỗi Chrome chạy một việc một lúc; muốn nhanh hơn hãy ghép thêm Chrome.
