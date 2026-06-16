import type { Issue } from "@/types";

export function friendlyIssueType(issue: Issue): string {
  if (issue.type === "ocr_low_confidence") return "đọc chữ trên ảnh";
  return issue.type;
}

export function friendlyIssueReason(reason: string): string {
  return reason
    .replace(
      /OCR confidence thấp \((\d+)%\)\. Cần người kiểm tra trực tiếp\./gu,
      "Typolice chưa đọc rõ chữ này ($1%). Bạn kiểm tra trực tiếp trên ảnh nhé."
    )
    .replace(
      /OCR có thể đã đọc icon\/trang trí thành ký tự ở đầu dòng\./gu,
      "Typolice có thể đã đọc nhầm icon/trang trí thành chữ ở đầu dòng."
    )
    .replace(
      /OCR có thể nhầm dấu hai chấm thành dấu gạch đứng sau nhãn thông tin\./gu,
      "Typolice có thể đã đọc nhầm dấu hai chấm thành dấu gạch đứng sau nhãn thông tin."
    )
    .replace(
      /Incorrect OCR of brand terms ([^.]+)\./giu,
      (_match, terms: string) => `Typolice có thể đã đọc sai tên thương hiệu ${terms.replace(/\s+and\s+/giu, " và ")}.`
    )
    .replace(
      /Incorrect OCR of ([^.]+)\./giu,
      "Typolice có thể đã đọc sai $1."
    )
    .replace(
      /Incorrect OCR of ([^.;]+)/giu,
      "Typolice có thể đã đọc sai $1"
    )
    .replace(/\bOCR confidence\b/giu, "độ tin cậy khi đọc chữ trên ảnh")
    .replace(/\bOCR text\b/giu, "chữ đã đọc từ ảnh")
    .replace(/\bOCR\b/giu, "kết quả đọc chữ trên ảnh");
}
