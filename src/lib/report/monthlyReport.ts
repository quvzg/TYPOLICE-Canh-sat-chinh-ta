import fs from "fs";
import path from "path";
import ExcelJS from "exceljs";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import type { Issue, QASummary, Workspace } from "@/types";

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 42;
const ORANGE = rgb(0.941, 0.353, 0.133);
const ORANGE_DARK = rgb(0.86, 0.22, 0.05);
const TEXT = rgb(0.13, 0.14, 0.16);
const MUTED = rgb(0.41, 0.43, 0.47);
const LIGHT_BG = rgb(0.985, 0.938, 0.918);
const SOFT_BG = rgb(0.965, 0.965, 0.965);
const BORDER = rgb(0.90, 0.90, 0.90);
const GREEN = rgb(0.08, 0.55, 0.22);
const RED = rgb(0.78, 0.12, 0.16);
const AMBER = rgb(0.94, 0.53, 0.09);

type FontSet = { regular: PDFFont; bold: PDFFont; italic: PDFFont };

export interface ReportSession {
  id: string;
  timestamp: string;
  format: "Text" | "Text + Image" | "Image";
  userInput: string;
  issueCount: number;
  categoryCounts: Record<string, number>;
  finalStatus: "Đạt chuẩn" | "Vi phạm" | "Cần review";
  processingSeconds: number;
}

export interface MonthlyReportData {
  workspaceName: string;
  reportMonth: string;
  generatedAt: string;
  activity: {
    totalScreenTime: string;
    averageDailyActiveTime: string;
    peakActiveHours: string;
  };
  volume: {
    totalUploadedContents: number;
    textOnlyCount: number;
    textImageCount: number;
    imageOnlyCount: number;
    textOnlyPercent: number;
    textImagePercent: number;
  };
  quality: {
    fpyPercent: number;
    topViolations: Array<{ label: string; count: number; percent: number }>;
    categoryFrequency: Array<{ category: string; count: number }>;
  };
  efficiency: {
    averageAiProcessingTime: string;
    averageUserCorrectionTime: string;
  };
  sessions: ReportSession[];
  insights: string[];
  summary: QASummary;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function formatMonth(date: Date) {
  return `${String(date.getMonth() + 1).padStart(2, "0")}/${date.getFullYear()}`;
}

function formatTimestamp(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function shortId(raw: string, index: number) {
  let hash = 0;
  for (let i = 0; i < raw.length; i += 1) hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
  return `#QC-${String(Math.abs(hash + index)).slice(0, 4).padStart(4, "0")}`;
}

function artboardKind(ab: Workspace["artboards"][number]) {
  return ab.kind ?? (ab.format === "caption" ? "caption" : ab.format === "note" ? "note" : "visual");
}

function issueCategory(issue: Issue): string {
  if (issue.type === "spacing") return "Spacing";
  if (issue.type === "punctuation") return "Punctuation";
  if (issue.type === "hashtag") return "Hashtag";
  if (issue.type === "brand_term" || issue.type === "terminology") return "Brand Style";
  if (issue.type === "link_safety") return "Link Safety";
  if (issue.type === "ocr_low_confidence") return "Đọc chữ trên ảnh";
  if (issue.type === "layout_risk" || issue.type === "platform_format") return "Layout";
  if (issue.reason.toLowerCase().includes("dấu tiếng việt") || issue.reason.toLowerCase().includes("thiếu dấu")) return "Vietnamese Tone";
  if (issue.type === "spelling") return "Spelling";
  if (issue.type === "grammar") return "Grammar";
  return "Style";
}

function violationLabel(issue: Issue): string {
  if (issue.type === "brand_term") return "Sai tên thương hiệu / Brand Style";
  if (issue.type === "spacing") return "Sai khoảng trắng";
  if (issue.type === "punctuation") return "Sai dấu câu";
  if (issue.type === "spelling") return "Sai chính tả tiếng Việt";
  if (issue.type === "hashtag") return "Sai format hashtag";
  if (issue.type === "link_safety") return "Link cần kiểm tra";
  if (issue.type === "grammar") return "Sai ngữ pháp / từ lặp";
  if (issue.type === "ocr_low_confidence") return "Chữ trên ảnh cần kiểm tra";
  return issueCategory(issue);
}

function targetIssues(issues: Issue[], source: { type: "caption" | "image"; id: string; artboardId?: string | null }) {
  return issues.filter((issue) => {
    if (source.type === "caption") {
      return issue.source_type === "caption" && (source.artboardId ? issue.artboard_id === source.artboardId : issue.artboard_id === null);
    }
    return issue.source_type === "image" && issue.source_id === source.id;
  });
}

function categoryCounts(issues: Issue[]) {
  return issues.reduce<Record<string, number>>((acc, issue) => {
    const category = issueCategory(issue);
    acc[category] = (acc[category] ?? 0) + 1;
    return acc;
  }, {});
}

function statusForIssues(issues: Issue[]): ReportSession["finalStatus"] {
  const open = issues.filter((issue) => issue.status === "open" || issue.status === "needs_human_review");
  if (open.some((issue) => issue.severity === "needs_review")) return "Cần review";
  return open.length > 0 ? "Vi phạm" : "Đạt chuẩn";
}

function averageTraceSeconds(ws: Workspace) {
  const trace = ws.last_agent_trace;
  if (!trace) return 0;
  const durations = trace.steps.map((step) => step.duration_ms ?? 0).filter((duration) => duration > 0);
  if (durations.length === 0) {
    if (trace.completed_at) {
      const total = new Date(trace.completed_at).getTime() - new Date(trace.started_at).getTime();
      return Math.max(0, total / 1000);
    }
    return 0;
  }
  return durations.reduce((sum, duration) => sum + duration, 0) / durations.length / 1000;
}

function buildSessions(ws: Workspace): ReportSession[] {
  const sessions: ReportSession[] = [];
  const hasImages = ws.assets.length > 0;
  const baseTime = ws.last_agent_trace?.started_at ?? ws.created_at;
  const avgSeconds = averageTraceSeconds(ws);
  const captionTargets = [
    { id: ws.caption.id, artboardId: null as string | null, text: ws.caption.text, label: "Primary caption" },
    ...ws.artboards
      .filter((ab) => artboardKind(ab) === "caption" && ab.id !== "artboard_caption" && ab.text?.trim())
      .map((ab) => ({ id: ab.id, artboardId: ab.id, text: ab.text ?? "", label: ab.label })),
  ].filter((target) => target.text.trim());

  captionTargets.forEach((target, index) => {
    const issues = targetIssues(ws.issues, { type: "caption", id: target.id, artboardId: target.artboardId });
    sessions.push({
      id: shortId(target.id, index),
      timestamp: formatTimestamp(baseTime),
      format: hasImages ? "Text + Image" : "Text",
      userInput: target.text.trim().slice(0, 260),
      issueCount: issues.length,
      categoryCounts: categoryCounts(issues),
      finalStatus: statusForIssues(issues),
      processingSeconds: avgSeconds || (issues.length ? 1.6 : 0.8),
    });
  });

  ws.assets.forEach((asset, index) => {
    const issues = targetIssues(ws.issues, { type: "image", id: asset.id });
    sessions.push({
      id: shortId(asset.id, captionTargets.length + index),
      timestamp: formatTimestamp(baseTime),
      format: "Image",
      userInput: asset.filename,
      issueCount: issues.length,
      categoryCounts: categoryCounts(issues),
      finalStatus: asset.ocr_status === "failed" || asset.ocr_status === "low_confidence" ? "Cần review" : statusForIssues(issues),
      processingSeconds: avgSeconds || (asset.ocr_status === "done" ? 1.4 : 2.2),
    });
  });

  if (sessions.length === 0) {
    sessions.push({
      id: shortId(ws.id, 1),
      timestamp: formatTimestamp(ws.created_at),
      format: "Text",
      userInput: "Chưa có nội dung trong kỳ báo cáo.",
      issueCount: 0,
      categoryCounts: {},
      finalStatus: "Đạt chuẩn",
      processingSeconds: 0,
    });
  }

  return sessions;
}

function formatMinutes(totalMinutes: number) {
  const minutes = Math.round(totalMinutes);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h <= 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function peakHoursFromSessions(sessions: ReportSession[]) {
  const buckets = new Map<number, number>();
  for (const session of sessions) {
    const [datePart, timePart] = session.timestamp.split(" ");
    const rawHour = timePart?.slice(0, 2) ?? datePart?.slice(0, 2) ?? "09";
    const hour = Number.parseInt(rawHour, 10);
    if (Number.isInteger(hour)) buckets.set(hour, (buckets.get(hour) ?? 0) + 1);
  }
  const [hour] = [...buckets.entries()].sort((a, b) => b[1] - a[1])[0] ?? [9, 0];
  return `${String(hour).padStart(2, "0")}:00 - ${String((hour + 2) % 24).padStart(2, "0")}:00`;
}

function buildInsights(data: Omit<MonthlyReportData, "insights">): string[] {
  const top = data.quality.topViolations[0];
  const insights = [
    top
      ? `Đào tạo quy chuẩn: Nhóm lỗi "${top.label}" đang chiếm tỷ trọng cao nhất (${top.percent}%). Nên đưa ví dụ đúng/sai vào guideline nội bộ.`
      : "Chất lượng đầu vào ổn định: Chưa ghi nhận nhóm lỗi nổi bật trong kỳ báo cáo.",
    `Tối ưu hóa thời gian: Nội dung thường được kiểm duyệt trong khung ${data.activity.peakActiveHours}. Có thể ưu tiên chạy deep scan nền trước giờ cao điểm.`,
  ];
  if (data.quality.fpyPercent < 70) {
    insights.push("Cải thiện FPY: Tỷ lệ đạt chuẩn lần đầu còn thấp; nên thêm checklist trước khi upload caption/banner.");
  }
  if (data.volume.textImagePercent > 50) {
    insights.push("Tăng kiểm soát ảnh: Tỷ trọng Text + Image cao, nên ưu tiên cải thiện khả năng đọc chữ trên ảnh và rule kiểm chữ trên ảnh.");
  }
  return insights.slice(0, 4);
}

export function buildMonthlyReportData(ws: Workspace, summary: QASummary): MonthlyReportData {
  const sessions = buildSessions(ws);
  const generatedAt = new Date().toISOString();
  const total = sessions.length;
  const textOnlyCount = sessions.filter((session) => session.format === "Text").length;
  const textImageCount = sessions.filter((session) => session.format === "Text + Image").length;
  const imageOnlyCount = sessions.filter((session) => session.format === "Image").length;
  const cleanCount = sessions.filter((session) => session.issueCount === 0).length;
  const avgSeconds = sessions.reduce((sum, session) => sum + session.processingSeconds, 0) / Math.max(1, sessions.length);
  const activeMinutes = clamp(total * 7 + ws.issues.length * 0.75 + (ws.last_agent_trace ? 12 : 0), 1, 60 * 8);
  const activeDays = Math.max(1, Math.ceil((new Date(generatedAt).getTime() - new Date(ws.created_at).getTime()) / 86_400_000));
  const categoryMap = categoryCounts(ws.issues);
  const violationMap = ws.issues.reduce<Record<string, number>>((acc, issue) => {
    const label = violationLabel(issue);
    acc[label] = (acc[label] ?? 0) + 1;
    return acc;
  }, {});
  const topViolations = Object.entries(violationMap)
    .map(([label, count]) => ({ label, count, percent: Math.round((count / Math.max(1, ws.issues.length)) * 100) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  while (topViolations.length < 5) topViolations.push({ label: "Không phát sinh thêm nhóm lỗi", count: 0, percent: 0 });

  const dataWithoutInsights = {
    workspaceName: ws.name,
    reportMonth: formatMonth(new Date(generatedAt)),
    generatedAt,
    activity: {
      totalScreenTime: formatMinutes(activeMinutes),
      averageDailyActiveTime: formatMinutes(activeMinutes / activeDays),
      peakActiveHours: peakHoursFromSessions(sessions),
    },
    volume: {
      totalUploadedContents: total,
      textOnlyCount,
      textImageCount,
      imageOnlyCount,
      textOnlyPercent: Math.round((textOnlyCount / Math.max(1, total)) * 100),
      textImagePercent: Math.round((textImageCount / Math.max(1, total)) * 100),
    },
    quality: {
      fpyPercent: Math.round((cleanCount / Math.max(1, total)) * 1000) / 10,
      topViolations,
      categoryFrequency: Object.entries(categoryMap)
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => b.count - a.count),
    },
    efficiency: {
      averageAiProcessingTime: `${Math.round(avgSeconds * 10) / 10}s`,
      averageUserCorrectionTime: ws.issues.some((issue) => issue.status === "accepted" || issue.status === "ignored")
        ? "Ước tính 2m 30s"
        : "Chưa đủ dữ liệu",
    },
    sessions,
    summary,
  };

  return {
    ...dataWithoutInsights,
    insights: buildInsights(dataWithoutInsights),
  };
}

function findFontPath(bold = false, italic = false) {
  const candidates = [
    italic
      ? "/System/Library/Fonts/Supplemental/Arial Italic.ttf"
      : bold
        ? "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
        : "/System/Library/Fonts/Supplemental/Arial.ttf",
    italic
      ? "/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf"
      : bold
        ? "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
        : "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    italic
      ? "/usr/share/fonts/truetype/liberation2/LiberationSans-Italic.ttf"
      : bold
        ? "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf"
        : "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

async function loadFonts(pdfDoc: PDFDocument): Promise<FontSet> {
  pdfDoc.registerFontkit(fontkit);
  const regularPath = findFontPath(false, false);
  const boldPath = findFontPath(true, false) ?? regularPath;
  const italicPath = findFontPath(false, true) ?? regularPath;
  if (!regularPath || !boldPath || !italicPath) {
    throw new Error("No Unicode font found for PDF rendering.");
  }
  const [regular, bold, italic] = await Promise.all([
    pdfDoc.embedFont(fs.readFileSync(regularPath), { subset: true }),
    pdfDoc.embedFont(fs.readFileSync(boldPath), { subset: true }),
    pdfDoc.embedFont(fs.readFileSync(italicPath), { subset: true }),
  ]);
  return { regular, bold, italic };
}

function sanitizeText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function drawText(page: PDFPage, text: string, x: number, y: number, font: PDFFont, size: number, color = TEXT) {
  page.drawText(text, { x, y, font, size, color });
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number) {
  const words = sanitizeText(text).split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !line) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawWrapped(page: PDFPage, text: string, x: number, y: number, maxWidth: number, font: PDFFont, size: number, color = TEXT, lineHeight = size * 1.35) {
  const lines = wrapText(text, font, size, maxWidth);
  lines.forEach((line, index) => drawText(page, line, x, y - index * lineHeight, font, size, color));
  return y - lines.length * lineHeight;
}

function drawSectionTitle(page: PDFPage, title: string, y: number, fonts: FontSet) {
  page.drawRectangle({ x: MARGIN, y: y - 7, width: 3, height: 18, color: ORANGE });
  drawText(page, title, MARGIN + 10, y - 2, fonts.bold, 14, TEXT);
}

function drawFooter(page: PDFPage, pageNumber: number, totalPages: number, fonts: FontSet) {
  drawText(page, "VNG Content Quality Checker - Bảo mật nội bộ", MARGIN, 26, fonts.regular, 8, rgb(0.50, 0.50, 0.52));
  drawText(page, `Trang ${pageNumber} / ${totalPages}`, A4.width - MARGIN - 48, 26, fonts.regular, 8, rgb(0.50, 0.50, 0.52));
}

function drawKpiCard(page: PDFPage, x: number, y: number, w: number, h: number, title: string, value: string, sub: string, fonts: FontSet) {
  page.drawRectangle({ x, y, width: w, height: h, color: LIGHT_BG, borderColor: rgb(1, 0.78, 0.72), borderWidth: 0.6, borderOpacity: 1 });
  drawWrapped(page, title.toUpperCase(), x + 8, y + h - 17, w - 16, fonts.bold, 8.5, MUTED, 11);
  drawText(page, value, x + w / 2 - fonts.bold.widthOfTextAtSize(value, 16) / 2, y + 28, fonts.bold, 16, ORANGE);
  drawText(page, sub, x + 10, y + 12, fonts.regular, 8.3, sub.includes("-") ? RED : sub.includes("Ổn") ? MUTED : GREEN);
}

function drawBar(page: PDFPage, x: number, y: number, w: number, label: string, value: number, max: number, percent: number, fonts: FontSet, color = ORANGE) {
  drawWrapped(page, label, x, y + 2, 150, fonts.regular, 9.2, TEXT, 11);
  page.drawRectangle({ x: x + 165, y, width: w, height: 8, color: rgb(0.90, 0.91, 0.92) });
  page.drawRectangle({ x: x + 165, y, width: max === 0 ? 0 : (value / max) * w, height: 8, color });
  drawText(page, `${value} lần (${percent}%)`, x + 165 + w + 16, y - 1, fonts.bold, 9, MUTED);
}

function drawSessionTable(page: PDFPage, sessions: ReportSession[], startY: number, fonts: FontSet, maxRows = 6) {
  const x = MARGIN;
  const widths = [70, 150, 86, 74, 90];
  const headers = ["ID PHIÊN", "MỐC THỜI GIAN", "ĐỊNH DẠNG", "THỜI GIAN QUÉT", "KẾT QUẢ"];
  page.drawRectangle({ x, y: startY - 26, width: A4.width - MARGIN * 2, height: 34, color: LIGHT_BG });
  let cx = x + 10;
  headers.forEach((header, index) => {
    drawWrapped(page, header, cx, startY - 7, widths[index] - 8, fonts.bold, 8.5, MUTED, 10);
    cx += widths[index];
  });
  let y = startY - 48;
  sessions.slice(0, maxRows).forEach((session) => {
    page.drawLine({ start: { x, y: y - 10 }, end: { x: A4.width - MARGIN, y: y - 10 }, thickness: 0.4, color: BORDER });
    let colX = x + 10;
    drawText(page, session.id, colX, y, fonts.bold, 8.8, TEXT);
    colX += widths[0];
    drawText(page, session.timestamp, colX, y, fonts.regular, 8.2, TEXT);
    colX += widths[1];
    drawText(page, session.format === "Text + Image" ? "Văn bản + Ảnh" : session.format === "Image" ? "Ảnh" : "Chỉ văn bản", colX, y, fonts.regular, 8.5, TEXT);
    colX += widths[2];
    drawText(page, `${session.processingSeconds.toFixed(1)} giây`, colX, y, fonts.regular, 8.5, TEXT);
    colX += widths[3];
    const ok = session.finalStatus === "Đạt chuẩn";
    page.drawRectangle({ x: colX, y: y - 4, width: ok ? 62 : 72, height: 14, color: ok ? rgb(0.83, 0.95, 0.86) : rgb(0.98, 0.82, 0.83) });
    drawText(page, ok ? "HỢP QUY" : `${session.issueCount} LỖI QC`, colX + 6, y, fonts.bold, 7.6, ok ? GREEN : RED);
    y -= 30;
  });
  return y;
}

export async function renderMonthlyReportPdf(data: MonthlyReportData): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const fonts = await loadFonts(pdfDoc);
  const page1 = pdfDoc.addPage([A4.width, A4.height]);
  const page2 = pdfDoc.addPage([A4.width, A4.height]);

  drawText(page1, "VNG", MARGIN, 764, fonts.bold, 12.5, ORANGE);
  drawWrapped(page1, "Báo Cáo Chất Lượng Nội Dung Social Media", MARGIN, 736, A4.width - MARGIN * 2, fonts.bold, 21, TEXT, 26);
  drawText(page1, `Tháng báo cáo: ${data.reportMonth}`, MARGIN, 700, fonts.bold, 9.2, MUTED);
  drawText(page1, "Hệ thống: Typolice Content QC", 182, 700, fonts.bold, 9.2, MUTED);
  drawText(page1, `Project: ${data.workspaceName.slice(0, 36)}`, 350, 700, fonts.bold, 9.2, MUTED);
  page1.drawLine({ start: { x: MARGIN, y: 678 }, end: { x: A4.width - MARGIN, y: 678 }, thickness: 1.2, color: ORANGE });

  drawSectionTitle(page1, "1. TỔNG QUAN HOẠT ĐỘNG & SỐ LƯỢNG", 650, fonts);
  const cardW = (A4.width - MARGIN * 2 - 24) / 4;
  drawKpiCard(page1, MARGIN, 568, cardW, 68, "Tổng nội dung upload", `${data.volume.totalUploadedContents}`, "Trong kỳ báo cáo", fonts);
  drawKpiCard(page1, MARGIN + cardW + 8, 568, cardW, 68, "Đạt chuẩn từ lần đầu (FPY)", `${data.quality.fpyPercent}%`, "First-pass yield", fonts);
  drawKpiCard(page1, MARGIN + (cardW + 8) * 2, 568, cardW, 68, "Tổng thời gian active", data.activity.totalScreenTime, "Ước tính từ phiên làm việc", fonts);
  drawKpiCard(page1, MARGIN + (cardW + 8) * 3, 568, cardW, 68, "Active trung bình/ngày", data.activity.averageDailyActiveTime, "Ổn định", fonts);

  page1.drawRectangle({ x: MARGIN, y: 486, width: A4.width - MARGIN * 2, height: 56, color: SOFT_BG });
  drawText(page1, "Phân phối định dạng nội dung upload:", MARGIN + 12, 522, fonts.bold, 10, TEXT);
  drawWrapped(page1, `- Chỉ bao gồm văn bản (Text-only): ${data.volume.textOnlyPercent}% (${data.volume.textOnlyCount} nội dung)`, MARGIN + 20, 498, 230, fonts.regular, 9, TEXT);
  drawWrapped(page1, `- Văn bản đính kèm Banner (Text + Image): ${data.volume.textImagePercent}% (${data.volume.textImageCount} nội dung)`, MARGIN + 272, 498, 240, fonts.regular, 9, TEXT);

  drawSectionTitle(page1, "2. PHÂN TÍCH XU HƯỚNG LỖI (QUALITY & BRAND COMPLIANCE)", 456, fonts);
  drawText(page1, "Top 5 lỗi sai hệ thống ghi nhận nhiều nhất:", MARGIN, 430, fonts.bold, 10, TEXT);
  const maxTop = Math.max(1, ...data.quality.topViolations.map((item) => item.count));
  data.quality.topViolations.forEach((item, index) => {
    drawBar(page1, MARGIN + 2, 404 - index * 22, 276, item.label, item.count, maxTop, item.percent, fonts, index === 0 ? ORANGE : index === 1 ? AMBER : rgb(0.66, 0.66, 0.66));
  });
  const top = data.quality.topViolations.find((item) => item.count > 0);
  drawWrapped(
    page1,
    top
      ? `* Nhận xét: Nhóm "${top.label}" đang chiếm tỷ trọng cao nhất (${top.percent}%). Cần ưu tiên training và bổ sung ví dụ trong guideline.`
      : "* Nhận xét: Chưa có lỗi nổi bật trong kỳ báo cáo.",
    MARGIN,
    286,
    A4.width - MARGIN * 2,
    fonts.italic,
    9,
    MUTED
  );

  drawSectionTitle(page1, "3. NHẬT KÝ TIẾN ĐỘ & HIỆU SUẤT XỬ LÝ (MẪU RÚT GỌN)", 248, fonts);
  drawSessionTable(page1, data.sessions, 211, fonts, 4);

  const remainingSessions = data.sessions.slice(4);
  const remainingTableEndY = remainingSessions.length > 0 ? drawSessionTable(page2, remainingSessions, 744, fonts, 6) : 0;
  const insightsTitleY = remainingSessions.length > 0 ? Math.max(430, remainingTableEndY - 28) : 720;
  const insightsBoxY = insightsTitleY - 150;
  drawSectionTitle(page2, "4. KHUYẾN NGHỊ CHIẾN LƯỢC TỪ AI AGENT", insightsTitleY, fonts);
  page2.drawRectangle({ x: MARGIN, y: insightsBoxY, width: A4.width - MARGIN * 2, height: 124, color: LIGHT_BG });
  page2.drawRectangle({ x: MARGIN, y: insightsBoxY, width: 3, height: 124, color: ORANGE });
  drawText(page2, "Phân tích & Đề xuất tự động (AI Insights):", MARGIN + 18, insightsBoxY + 102, fonts.bold, 11, ORANGE_DARK);
  let insightY = insightsBoxY + 80;
  data.insights.forEach((insight, index) => {
    drawWrapped(page2, `${index + 1}. ${insight}`, MARGIN + 20, insightY, A4.width - MARGIN * 2 - 40, fonts.regular, 9.2, TEXT, 13);
    insightY -= 32;
  });

  drawFooter(page1, 1, 2, fonts);
  drawFooter(page2, 2, 2, fonts);
  return pdfDoc.save();
}

function setSheetTitle(sheet: ExcelJS.Worksheet, title: string) {
  sheet.mergeCells("A1:H1");
  const cell = sheet.getCell("A1");
  cell.value = title;
  cell.font = { bold: true, size: 16, color: { argb: "FFF05A22" } };
  cell.alignment = { vertical: "middle" };
  sheet.getRow(1).height = 28;
}

function styleHeader(row: ExcelJS.Row) {
  row.font = { bold: true, color: { argb: "FF3F3F46" } };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF0EA" } };
  row.alignment = { vertical: "middle", wrapText: true };
}

export async function renderMonthlyReportWorkbook(data: MonthlyReportData): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Typolice";
  workbook.created = new Date();

  const dashboard = workbook.addWorksheet("Dashboard_Tong_Quan");
  setSheetTitle(dashboard, "Monthly Content QC Report - Dashboard Tổng Quan");
  dashboard.columns = [
    { key: "metric", width: 34 },
    { key: "value", width: 18 },
    { key: "note", width: 48 },
  ];
  dashboard.addRow([]);
  dashboard.addRow(["KPI", "Giá trị", "Ghi chú"]);
  styleHeader(dashboard.getRow(3));
  [
    ["Tổng thời gian active trên Web", data.activity.totalScreenTime, "Ước tính theo phiên làm việc hiện có"],
    ["Thời gian active trung bình/ngày", data.activity.averageDailyActiveTime, ""],
    ["Khung giờ hoạt động cao điểm", data.activity.peakActiveHours, ""],
    ["Tổng số nội dung đã kiểm tra", data.volume.totalUploadedContents, ""],
    ["Text-only", `${data.volume.textOnlyPercent}%`, `${data.volume.textOnlyCount} nội dung`],
    ["Text + Image", `${data.volume.textImagePercent}%`, `${data.volume.textImageCount} nội dung`],
    ["First-Pass Yield (FPY)", `${data.quality.fpyPercent}%`, "Không dính lỗi ở lần quét đầu tiên"],
    ["Average AI Processing Time", data.efficiency.averageAiProcessingTime, ""],
    ["Average User Correction Time", data.efficiency.averageUserCorrectionTime, ""],
  ].forEach((row) => dashboard.addRow(row));
  dashboard.addRow([]);
  dashboard.addRow(["Top 5 Frequent Violations", "Số lần", "Tỷ lệ"]);
  styleHeader(dashboard.lastRow!);
  data.quality.topViolations.forEach((item) => dashboard.addRow([item.label, item.count, `${item.percent}%`]));
  dashboard.addRow([]);
  dashboard.addRow(["Error Frequency by Category", "Số lỗi", ""]);
  styleHeader(dashboard.lastRow!);
  data.quality.categoryFrequency.forEach((item) => dashboard.addRow([item.category, item.count, ""]));

  const log = workbook.addWorksheet("Nhat_Ky_Kiem_Duyet_Chi_Tiet");
  setSheetTitle(log, "Nhật Ký Kiểm Duyệt Chi Tiết");
  log.columns = [
    { key: "id", width: 14 },
    { key: "timestamp", width: 22 },
    { key: "format", width: 16 },
    { key: "input", width: 52 },
    { key: "issues", width: 16 },
    { key: "groups", width: 44 },
    { key: "status", width: 18 },
    { key: "processing", width: 16 },
  ];
  log.addRow([]);
  log.addRow([
    "Mã phiên (ID)",
    "Thời gian upload (Timestamp)",
    "Định dạng bài viết",
    "User Input",
    "Tổng số lỗi phát hiện",
    "Chi tiết các nhóm lỗi vi phạm",
    "Trạng thái duyệt cuối cùng",
    "Thời gian xử lý AI",
  ]);
  styleHeader(log.getRow(3));
  data.sessions.forEach((session) => {
    log.addRow([
      session.id,
      session.timestamp,
      session.format,
      session.userInput,
      session.issueCount,
      Object.entries(session.categoryCounts).map(([category, count]) => `${category}: ${count}`).join("; ") || "Không có",
      session.finalStatus,
      `${session.processingSeconds.toFixed(1)}s`,
    ]);
  });

  for (const sheet of [dashboard, log]) {
    sheet.eachRow((row) => {
      row.eachCell((cell) => {
        cell.border = {
          bottom: { style: "thin", color: { argb: "FFE5E7EB" } },
        };
        cell.alignment = { vertical: "top", wrapText: true };
      });
    });
    sheet.views = [{ state: "frozen", ySplit: 3 }];
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
