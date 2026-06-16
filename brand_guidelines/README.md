# Brand Guidelines

Bỏ file brand guideline / style guide / campaign rule vào folder này — agent sẽ tự đọc, không cần sửa code.

| File/folder | Vai trò |
|---|---|
| `brand_kit.json` | Structured rules: protected terms, preferred spellings, do-not-change terms. |
| `style_guide.md` | Quy tắc viết, dấu câu, viết hoa (được đưa vào prompt LLM). |
| `tone_of_voice.md` | Tone mong muốn và tone cần tránh (được đưa vào prompt LLM). |
| `terminology.csv` | `wrong,correct` — mapping từ sai sang từ đúng (rule checker dùng trực tiếp). |
| `campaigns/*.json` | Rule riêng theo campaign, **override** rule global. |
| `examples/` | Caption đã duyệt/bị reject để làm few-shot guidance. |

Thứ tự ưu tiên khi conflict: campaigns → brand_kit.json → CSV → markdown → model suggestion.

Hashtag chỉ được check format (ví dụ không có khoảng trắng sau `#`), không dùng allowed list.

⚠️ Không đặt API key, token, password hay credential vào folder này.
