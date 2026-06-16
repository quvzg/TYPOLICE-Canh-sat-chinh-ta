# Hướng Dẫn Sử Dụng Typolice Agent

Typolice là workspace QA cho social content. Team có thể upload poster/banner, paste caption tiếng Việt, sắp layout Facebook/LinkedIn, chạy agent để bắt lỗi caption, text trên ảnh, hashtag, brand term, link/QR và xuất report trước khi publish.

## 1. Mở app

Khi có link online, mở link trên trình duyệt. Giao diện gồm 3 khu vực chính:

- **Assets** bên trái: upload và quản lý ảnh/poster.
- **Canvas** ở giữa: tạo artboard, kéo thả ảnh, review highlight trên caption/ảnh.
- **QA Panel** bên phải: xem agent trace, danh sách lỗi, caption đã sửa, Brand Kit và export report.

Badge trên thanh trên cùng cho biết chế độ đang chạy:

- **AI agent ready**: đã cấu hình AI gateway, agent dùng rules + LLM.
- **Rules only**: chưa cấu hình key, app vẫn bắt lỗi bằng rule-based checker và OCR cơ bản.

## 2. Workflow test nhanh

1. Bấm **Reset** nếu muốn xoá workspace test cũ.
2. Trong panel **Caption**, chuyển sang **Edit** và paste caption cần QA.
3. Đợi vài giây để rule checker tự động bắt lỗi caption.
4. Bấm **+ Caption** trên canvas nếu cần tạo caption artboard riêng.
5. Bấm **Upload** trong panel Assets để upload poster/banner.
6. Kéo ảnh từ Assets vào artboard trên canvas.
7. Chọn preset Facebook/LinkedIn nếu muốn test đúng format social.
8. Bấm **Run** trên artboard/canvas để chạy Typolice Agent.
9. Mở tab **Agent** để xem workflow trace từng bước.
10. Mở tab **Issues** để xử lý từng lỗi: Accept, Ignore hoặc + Dict.
11. Mở tab **Corrected** để copy caption đã sửa.
12. Mở tab **Export** hoặc nút **Export** trên top bar để tải QA report Markdown.

Caption demo có thể paste:

```text
Tại VNG,  AI đang dần trở thành một phần trong công việc hằng ngày.
Tinh thần lan tỏa mạnh mẻ hơn bao giờ hết .
GreenNode Claw -a-thon đã chính thức khỏi động, mỡ ra sân chơi mới.
Các đội thi sẻ phát triển AI Agent cho người dùng no-tech.
# ClawathonShortcut #LifeatVNG
```

## 3. Các tính năng chính

### Caption QA

- Tự động scan caption sau khi paste.
- Bắt lỗi chính tả, khoảng trắng, dấu câu, hashtag, brand spelling, style và một số mẫu câu dễ gây hiểu nhầm.
- Highlight trực tiếp trong caption.
- Hover highlight để xem original, suggestion, reason và confidence.
- **Accept** áp dụng sửa lỗi vào caption.
- **Ignore** bỏ qua lỗi không cần sửa.
- **+ Dictionary / + Dict** thêm term vào Brand Kit để lần sau không bị báo lại.

### Image Text QA Và OCR

- Upload nhiều ảnh poster/banner.
- App tự chạy OCR để đọc text trong ảnh.
- OCR được cache theo file hash, kéo/resize ảnh không cần OCR lại.
- Khi có AI vision, agent có thể sửa OCR text dựa trên ảnh gốc và cross-check lỗi trong text trên poster.
- Lỗi trên ảnh được hiển thị theo asset và có overlay/issue card để team ghi nhận.

### Layout Workspace

- Tạo artboard theo preset Facebook và LinkedIn.
- Kéo thả asset vào artboard.
- Dùng canvas để review nhiều format trong cùng một workspace.
- Có caption artboard riêng để review caption như một deliverable social.

### Agent Trace

Tab **Agent** hiển thị rõ các bước agent đã chạy:

- Load Brand Kit/guideline.
- Caption rules.
- Qwen caption QA nếu được cấu hình.
- MiniMax verifier để giảm false positive.
- Link/QR safety.
- OCR image text.
- Vision OCR correction nếu cần.
- Image text QA bằng rules/LLM.
- Merge/dedupe issue vào workspace memory.
- Chuẩn bị report.

Mỗi bước có status, tool/model, số item và thời gian chạy để demo automation workflow.

### Corrected Caption

Tab **Corrected** tạo caption đã sửa dựa trên issue có suggestion rõ ràng. Team có thể:

- Xem số lỗi open/accepted/ignored.
- Copy corrected caption.
- Apply all definite fixes nếu muốn chấp nhận các sửa lỗi chắc chắn.

### Brand Kit Và Guideline Memory

App đọc guideline từ thư mục `brand_guidelines/`, bao gồm:

- Brand terms.
- Protected terms / do-not-change.
- Preferred terminology.
- Hashtag format rules.
- Style guide.
- Campaign-specific rules.

Khi bấm **+ Dict**, app cập nhật Brand Kit để ghi nhớ term hợp lệ cho lần scan sau.

### Export Report

Report Markdown gồm:

- Summary QA.
- Issues theo severity/source.
- Caption đã sửa.
- Danh sách issue đã ignore/accepted.

Dùng report này để gửi lại cho content/design team trước khi publish.

## 4. Lưu ý khi team test trên link online

- Mọi người đang dùng chung một workspace online, nên thao tác của người này có thể ảnh hưởng người khác.
- Bấm **Reset** sẽ xoá caption, assets, artboards, issues và agent trace hiện tại. Brand Kit/guidelines vẫn được giữ lại.
- Upload nhiều ảnh lớn và OCR sẽ tốn CPU/RAM hơn bình thường.
- Nếu badge là **Rules only**, các tính năng LLM/vision/report writer có thể bị skip, nhưng rule-based QA và OCR vẫn hoạt động.
- Nếu agent đang chạy deep scan, đợi đến khi tab Agent hết trạng thái running/deep scan rồi mới export report.

## 5. Giới hạn hiện tại

- Đây là MVP hackathon, workspace mặc định chỉ có một chiến dịch.
- Upload và workspace data được lưu trên server runtime trong thư mục `storage/`.
- Chưa có multi-user permission, login, realtime collaboration, export PNG/PDF artboard hay auto-post.
- Lỗi text trên ảnh thường cần sửa trong file design gốc, app chỉ đánh dấu và ghi nhận issue.
