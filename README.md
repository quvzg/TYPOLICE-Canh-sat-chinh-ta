# Typolice — AI Social Content QA Workspace

Workspace dạng canvas cho team truyền thông/marketing: upload nhiều visual, sắp layout Facebook/LinkedIn, paste caption tiếng Việt, chạy AI QA — lỗi được highlight đúng vị trí trong caption và trên ảnh, hover để xem gợi ý, Accept/Ignore từng lỗi, xuất QA report kèm caption đã sửa.

## Claw-a-thon positioning

**Track:** Automation & Integration.

**Problem:** Social/marketing teams mất nhiều thời gian soi thủ công caption, poster text, hashtag, brand spelling và guideline trước khi publish.

**Agent solution:** Typolice tự chạy workflow QA end-to-end: đọc guideline, OCR ảnh, kiểm tra rule chắc chắn, gọi nhiều model để review ngữ cảnh/vision/verifier, lưu human decision, học guideline mới và xuất report.

**Value:** giảm thao tác lặp lại trước khi publish, giảm lỗi brand/copy, vẫn giữ human-in-loop cho quyết định cuối.

## Chạy app

```bash
npm install
cp .env.example .env.local   # điền key nếu muốn dùng LLM (không bắt buộc)
npm run dev                  # http://localhost:3000
```

**Không có API key vẫn chạy được** — app tự rơi về chế độ rules-only: toàn bộ rule-based checker tiếng Việt, OCR, layout check, report vẫn hoạt động. Badge trên top bar hiển thị `○ rules only` / `● 3-model agent ready`.

> Lần đầu chạy OCR, tesseract.js sẽ tải Vietnamese traineddata (~vài MB) về `storage/tessdata/` — cần internet một lần.

## Cấu hình LLM (.env.local)

```text
AI_GATEWAY_BASE_URL=   # OpenAI-compatible endpoint, vd: https://gateway.example.com/v1
AI_GATEWAY_API_KEY=    # secret — KHÔNG commit
MODEL_ID_QWEN=         # model id thật trên gateway, vd: qwen/qwen3.5-27b
MODEL_ID_MINIMAX=
MODEL_ID_GEMMA=        # cần vision để cross-check ảnh

# Optional external fallback for image OCR/cross-check
GEMINI_API_KEY=        # secret — KHÔNG commit, set ở .env.local hoặc AgentBase runtime env
MODEL_ID_GEMINI=gemini-2.5-flash-lite
```

Routing theo role: `MODEL_CAPTION_QA=qwen`, `MODEL_VERIFY=minimax`, `MODEL_IMAGE_QA=gemma`, `MODEL_REPORT=minimax`. Key chỉ được đọc ở server (API routes); log lỗi tự redact key.

Muốn dùng Gemini cho phần đọc ảnh thì set:

```text
MODEL_IMAGE_QA=gemini
GEMINI_API_KEY=<set in runtime secret>
MODEL_ID_GEMINI=gemini-2.5-flash-lite
```

Gemini là external optional fallback; nếu dùng khi submit Claw-a-thon cần khai báo rõ trong README/demo. Không đưa key thật lên GitHub hay Dockerfile.

Model orchestration:

- **Qwen**: caption QA, tìm lỗi tiếng Việt/ngữ cảnh/brand/style.
- **MiniMax**: verifier chống false positive và report writer.
- **Gemma**: vision OCR correction + image text QA.
- **Gemini optional**: có thể thay role `image_qa` cho Deep image scan khi cần fallback vision/OCR ngoài MaaS.

## Luồng demo

1. Paste caption có lỗi vào Caption editor (panel dưới canvas) — rule checker chạy tự động sau ~0.8s, lỗi được highlight inline.
2. Hover vào highlight → popover Original/Suggestion/Reason/Confidence + Accept/Ignore/+Dictionary.
3. Upload 3–6 poster (panel trái) — OCR chạy nền, badge hiển thị trạng thái.
4. Bấm preset (FB Feed Square, LI Carousel…) để tạo artboard, kéo ảnh từ panel trái thả vào artboard.
5. Bấm **Run Agent QA** — agent tự chạy guideline loader → rules → Qwen caption QA → MiniMax verifier → OCR/Gemma image QA → merge decisions.
6. Tab **Agent** — xem workflow trace: từng bước, model/tool dùng, status, duration và số issue.
7. Tab **Corrected** — caption đã sửa (definite fixes, confidence ≥ 0.85), copy 1 click.
8. Tab **Export** — tải QA report Markdown/JSON.

Caption mẫu để demo:

```text
Tại VNG,  AI đang dần trở thành một phần trong công việc hằng ngày.
Tinh thần lan tỏa mạnh mẻ hơn bao giờ hết .
GreenNode Claw -a-thon đã chính thức khỏi động, mỡ ra sân chơi mới.
Các đội thi sẻ phát triển AI Agent cho người dùng no-tech.
# ClawathonShortcut #LifeatVNG
```

## Kiến trúc

```text
src/
├── types/                  # Unified Issue schema dùng chung caption/image/layout
├── lib/
│   ├── qa/
│   │   ├── ruleChecker.ts      # deterministic VN checks (chạy trước LLM, fast path)
│   │   ├── issueMerger.ts      # validate exact substring, locate range, merge/dedupe
│   │   ├── patchService.ts     # apply fixes end→start, giữ nguyên emoji/line break
│   │   └── layoutChecker.ts    # legacy layout risks (không chạy image QA text-only flow)
│   ├── brand/brandGuidelineLoader.ts  # parse brand_guidelines/ (json+csv+md), cache theo hash
│   ├── models/
│   │   ├── gateway.ts          # OpenAI-compatible client, redacted logging, JSON extract
│   │   └── adapters.ts         # caption QA / verifier / Gemma vision / report prompts
│   ├── ocr/ocrService.ts       # sharp preprocess + tesseract.js vie+eng, line bbox, versioned cache
│   ├── ocr/ocrVisionCorrection.ts # Gemma sửa OCR text theo ảnh, giữ bbox từ Tesseract
│   ├── server/db.ts            # JSON persistence (storage/workspace.json)
│   └── store.ts                # Zustand client store
├── app/api/                # upload, ocr, analyze, run-qa, report, brand-kit, files
└── components/             # TopBar, AssetPanel, CanvasArea, CaptionEditor, QAPanel
```

Nguyên tắc cốt lõi (theo spec):

- **LLM chỉ trả structured JSON** — không bao giờ tin offset của LLM; backend tìm exact substring (`locateRange` + context disambiguation), quote không tồn tại thì loại.
- **Rules trước, LLM sau** — kết quả rule-based hiện ngay, LLM bổ sung khi Run QA / Deep check.
- **3-model agent orchestration** — Qwen caption QA, MiniMax verifier/report, Gemma vision image QA.
- **Verifier pass** chống sửa bừa, chỉ chạy trên issue do LLM tìm ra.
- **Agent Run Trace** — backend trả log từng bước để demo rõ đây là automation workflow chứ không chỉ là editor.
- **Brand Kit là whitelist** — term trong `do_not_change` không bao giờ bị sửa; "+ Dictionary" ghi thẳng vào `brand_guidelines/brand_kit.json`.
- **Cache theo content hash** — caption QA cache theo text+brand kit; OCR cache theo file hash (kéo/resize ảnh không OCR lại, chỉ transform bbox).

## Brand guidelines

Bỏ file vào `brand_guidelines/` (xem README trong folder đó). Ưu tiên khi conflict: `campaigns/*.json` → `brand_kit.json` → CSV → markdown → model suggestion.

## Khác biệt so với spec v1.2 (có chủ đích)

| Spec | Bản build | Lý do |
|---|---|---|
| PaddleOCR | tesseract.js | Single-stack Node, không cần Python service; vẫn có bbox + confidence |
| Tiptap editor | Review/Edit toggle | Ổn định với IME tiếng Việt/emoji, range mapping đơn giản, đủ cho flow paste→review |
| Konva canvas | DOM + CSS transform | Overlay bbox/hover bằng HTML dễ hơn; đủ cho pan/zoom/drag-drop |
| SQLite/Postgres | JSON file | Zero infra cho hackathon; interface `db.ts` dễ swap sau |
| Workspace CRUD nhiều endpoint | 1 workspace mặc định | Demo chỉ cần 1 campaign |
| Spec chỉ có API key | Thêm `AI_GATEWAY_BASE_URL` + `MODEL_ID_*` | Thiếu thì không gọi được gateway |

## Chưa làm (ngoài scope MVP)

Export PNG/PDF artboard, carousel reorder, crop tool, multi-workspace, realtime collab, auto-post.
