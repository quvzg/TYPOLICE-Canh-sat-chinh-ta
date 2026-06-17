# Typolice - Cảnh sát chính tả

## Mô tả ngắn

Typolice giúp đội Marketing/Truyền thông bắt typo, kiểm tra guideline trên caption và hình ảnh, rồi xuất report PDF/Excel để duyệt nội dung nhanh và đúng brand hơn.

## Giới thiệu

BẠN SẼ TIẾP TỤC MẮC LỖI CHÍNH TẢ. Trừ khi bạn sử dụng Typolice - một agent để bắt typo, kiểm tra compliance và giúp bạn vượt qua vòng duyệt nội dung dễ dàng.

Mỗi ngày, các đội ngũ Marketing và Truyền thông phải xử lý hàng chục bài đăng, ấn phẩm và nội dung chiến dịch. Chỉ một lỗi chính tả, một từ ngữ không phù hợp hoặc một chi tiết sai guideline cũng có thể khiến nội dung bị trả về, làm chậm tiến độ và ảnh hưởng đến hình ảnh thương hiệu.

Được xây dựng trên GreenNode AgentBase, Typolice không chỉ kiểm tra lỗi trên cả nội dung và hình ảnh mà còn cho phép đội ngũ tạo lập không gian làm việc riêng cho từng thương hiệu hoặc chiến dịch. Mỗi project có thể được tùy chỉnh bộ guideline, thuật ngữ và quy chuẩn kiểm duyệt riêng, giúp nội dung luôn được đánh giá đúng theo tiêu chuẩn của từng brand.

Thay vì chỉ liệt kê lỗi, Typolice giúp người dùng nhìn thấy bức tranh toàn cảnh: những lỗi nào xuất hiện nhiều nhất, guideline nào thường bị vi phạm và đâu là các điểm nghẽn trong quy trình kiểm duyệt nội dung dưới dạng report PDF hoặc Excel.

Hãy khám phá Typolice và gia nhập Cục Bảo Hộ Quyền Chính Tả ngay hôm nay!

## Người dùng

- Marketing, Social, Branding, Internal Comms và Content team.
- Người duyệt nội dung cần kiểm tra nhiều caption/poster trước khi publish.
- Team campaign cần guideline riêng cho từng thương hiệu, sự kiện hoặc dự án.

## Vấn đề

- Caption và poster dễ dính typo, spacing, punctuation, hashtag sai format hoặc lỗi brand term.
- Text trên ảnh khó kiểm thủ công, đặc biệt khi có nhiều banner/poster cùng lúc.
- Guideline theo từng campaign dễ bị áp dụng nhầm hoặc bị bỏ sót.
- Manager cần report để biết lỗi nào lặp lại nhiều và nội dung nào đang vi phạm guideline.

## Giải pháp

Typolice là AI Agent kiểm duyệt content theo workflow rõ ràng:

1. Chạy rule deterministic trước để trả kết quả nhanh và ổn định.
2. Đọc chữ trên ảnh bằng OCR nhiều pass, bỏ qua logo/type logo và vùng trang trí.
3. Dùng model AI để deep check caption, chữ trên ảnh và verifier chống false positive.
4. Merge kết quả theo từng card nội dung, giữ quyết định Checked/Ignore của user.
5. Tạo report PDF tổng quan và Excel log chi tiết để tracking chất lượng nội dung.

## Tính năng hiện tại

- **Checker mode**: tạo nhiều caption card và image card để kiểm nhiều nội dung trong một luồng.
- **Project mode**: mở workspace dạng space/canvas cho campaign, có thể thêm artboard caption, note và layout ảnh social.
- **Guidelines theo project**: upload guideline riêng cho từng project; guideline chỉ áp dụng trong project đó.
- **Rule tổng của app**: giữ các spelling/brand/common rule nền để kiểm tra nhanh mà không cần model.
- **Run theo card**: bấm Run ở card nào thì chỉ check card đó, không làm ảnh hưởng card khác.
- **Fast result + deep result**: kết quả nhanh hiện trước, deep scan tự chạy nền và merge thêm khi xong.
- **Coverage status**: mỗi card hiển thị Checked, Still checking, Needs review hoặc Could not fully read.
- **Cache thông minh**: reuse kết quả theo content hash, brand kit hash, prompt version và model role.
- **OCR tối ưu**: warm scan khi upload/drop ảnh, multi-pass OCR, không cache rỗng vĩnh viễn.
- **Image text QA**: chỉ check lỗi chữ trên ảnh; không check lỗi design như safe zone/crop/layout.
- **Issue review**: hover lỗi ngay trên text/ảnh, xem lý do, suggestion và chọn Checked/Ignore/+Dict.
- **Issue panel theo card**: tab Issues gom lỗi theo từng caption/image card, có thể thu gọn từng nhóm.
- **Report**: export PDF report và Excel log cho nội dung đã kiểm.
- **Guideline viewer**: user có thể xem lại file guideline đã upload.
- **Light/Dark mode**: giao diện mặc định light mode, có toggle đổi theme.

## Luồng sử dụng

### 1. Quick Checker

1. Mở app, chọn **Checker**.
2. Nhập caption vào card đầu tiên hoặc bấm **Add New Caption** để thêm nhiều caption.
3. Upload hoặc kéo thả poster/banner vào **Visual Text Scanner**.
4. Bấm nút **Run** trên từng card.
5. Typolice hiện lỗi ngay trên text/ảnh và gom lỗi theo card trong tab **Issues**.
6. User chọn **Checked** cho lỗi đã tự xem lại, **Ignore** nếu không áp dụng, hoặc **+Dict** để thêm vào guideline/dictionary.
7. Tải **PDF report** hoặc **Excel log** khi cần bàn giao/tracking.

### 2. Project Space

1. Chọn **Project** để vào workspace dạng canvas.
2. Tạo project cho từng campaign/thương hiệu.
3. Thêm caption artboard, note artboard hoặc layout ảnh Facebook/LinkedIn.
4. Upload guideline riêng của project.
5. Click hoặc kéo thả ảnh vào đúng slot của layout.
6. Run từng artboard; kết quả chỉ áp dụng cho artboard/card đang kiểm.
7. Xuất report cho project khi hoàn tất review.

## Guideline upload

Typolice hỗ trợ các định dạng thân thiện cho non-tech user:

- PDF
- DOC/DOCX
- XLS/XLSX/CSV
- JSON
- Markdown

Khuyến nghị cho team non-tech:

- Dùng **PDF/DOCX** nếu guideline là tài liệu mô tả tone of voice, cách viết, term cần tránh.
- Dùng **Excel/CSV** nếu guideline là bảng thuật ngữ: sai/đúng, do-not-change, preferred wording.
- Dùng **JSON/Markdown** nếu team kỹ thuật muốn kiểm soát cấu trúc rõ hơn.

Guideline upload trong project sẽ bổ sung/override rule nền cho project đang mở. Nếu user upload file mới hoặc cập nhật guideline trong UI, app sẽ đọc lại guideline cho lần Run tiếp theo.

## Model orchestration

Typolice ưu tiên deterministic rules trước, sau đó dùng AI theo role:

- **Qwen**: caption QA, tìm lỗi tiếng Việt/ngữ cảnh/brand/style.
- **MiniMax**: verifier chống false positive và viết report.
- **Gemma**: vision OCR correction và image text QA trên AgentBase/MaaS.
- **Gemini optional**: external fallback cho image QA khi cần tăng khả năng đọc chữ trên ảnh.

External model disclosure:

- External provider optional: **Google Gemini API**.
- Current optional role: `MODEL_IMAGE_QA=gemini`.
- Default external model id: `gemini-2.5-flash-lite`.
- API key chỉ được truyền qua runtime environment như `GEMINI_API_KEY`.
- Không commit API key vào GitHub, Dockerfile hoặc client-side code.

AgentBase/MaaS fallback:

- Khi chạy trên GreenNode AgentBase, app có thể dùng `GREENNODE_CLIENT_ID` và `GREENNODE_CLIENT_SECRET` do runtime inject để lấy GreenNode AIP/MaaS access.
- Nếu `AI_GATEWAY_API_KEY` không được set thủ công, server có thể fallback sang IAM/AIP theo cấu hình runtime.

## Cấu hình local

```bash
npm install
cp .env.example .env.local
npm run dev
```

Mặc định app chạy tại:

```text
http://localhost:3000
```

Không có API key, Typolice vẫn chạy được rule-based checks, OCR local và report. Khi có model runtime env, app bật deep check qua các model đã cấu hình.

## Biến môi trường chính

```text
AI_GATEWAY_BASE_URL=
AI_GATEWAY_API_KEY=
MODEL_ID_QWEN=
MODEL_ID_MINIMAX=
MODEL_ID_GEMMA=

GEMINI_API_KEY=
MODEL_ID_GEMINI=gemini-2.5-flash-lite

MODEL_CAPTION_QA=qwen
MODEL_VERIFY=minimax
MODEL_IMAGE_QA=gemma
MODEL_REPORT=minimax

GREENNODE_AIP_FALLBACK=true
GREENNODE_MAAS_BASE_URL=https://maas-llm-aiplatform-hcm.api.vngcloud.vn/v1
GREENNODE_AIP_API_KEY_NAME=
GREENNODE_AIP_AUTO_CREATE_KEY=false
```

Không đưa key thật vào README, Dockerfile hoặc source code.

## Kiến trúc

```text
src/
├── app/
│   ├── api/
│   │   ├── assets/              # upload ảnh, OCR per asset
│   │   ├── brand-kit/           # guideline upload + patch dictionary
│   │   ├── report/              # PDF/Excel report
│   │   └── workspace/           # workspace, run-qa, deep-scan job + commit
│   └── health/                  # health check cho AgentBase
├── components/
│   ├── AppSidebar.tsx           # Project/Checker navigation + history
│   ├── BasicCheckMain.tsx       # Checker mode: caption/image cards
│   ├── CanvasArea.tsx           # Project space/canvas
│   ├── QAPanel.tsx              # Issues/Corrected/Guidelines/Export panel
│   └── IssueHoverCard.tsx       # hover issue details + actions
├── lib/
│   ├── brand/                   # guideline parser/loader
│   ├── models/                  # gateway, adapters, MaaS/IAM fallback, cache
│   ├── ocr/                     # tesseract.js OCR, image payload preprocess
│   ├── qa/                      # rule checker, issue merge, deep scan jobs
│   ├── report/                  # monthly PDF/Excel report builder
│   └── store.ts                 # Zustand state + run orchestration
└── types/                       # shared Issue/Asset/Workspace schema
```

## Pipeline QA

```text
Run card
  → Fast deterministic checks
  → Warm/reuse OCR cache
  → Start deep-scan job
  → Caption AI
  → Image AI
  → Self-check/verifier
  → Safe commit if content fingerprint still matches
  → Merge result into the same card
```

Nguyên tắc an toàn:

- Không tin offset từ LLM; mọi issue phải map được về text/bbox thật.
- Nếu candidate chưa chắc nhưng có exact text/bbox, hiển thị dạng Needs review thay vì bỏ mất.
- Nếu user sửa nội dung trong lúc deep scan, server không commit kết quả cũ.
- Retry theo step/model cache, tránh chạy lại toàn bộ Run từ đầu.
- Không scan QR/link safety để giảm thời gian check và giữ scope content QA.

## Report

Typolice xuất:

- **PDF**: executive summary, quality/brand compliance, velocity/timestamp và strategic insights.
- **Excel**: dashboard tổng quan và log kiểm duyệt chi tiết theo từng phiên/nội dung.

Report dùng dữ liệu issues, card, upload timestamp, agent trace và trạng thái review hiện tại.

## Triển khai AgentBase

Runtime khuyến nghị:

```text
Flavor: runtime-s2-general-4x8
CPU/RAM: 4 vCPU / 8 GB RAM
Min replicas: 1
Max replicas: 1
CPU scale: 70%
Memory scale: 75%
Network: PUBLIC
Port: 8080
```

Dockerfile đã bundle OCR runtime data `vie+eng` để endpoint không phải tải traineddata khi khởi động.

## Claw-a-thon positioning

**Track:** Coding & Automation / Automation & Integration.

**Problem:** Marketing/Comms team mất nhiều thời gian soi thủ công caption, poster text, hashtag, brand spelling và guideline trước khi publish.

**Agent solution:** Typolice tự động đọc guideline, đọc chữ trên ảnh, chạy rule chắc chắn, gọi nhiều model cho deep check/verifier, lưu human decision và xuất report.

**Value:** giảm lỗi chính tả/brand compliance, giảm thời gian duyệt nội dung, vẫn giữ human-in-loop cho quyết định cuối.

