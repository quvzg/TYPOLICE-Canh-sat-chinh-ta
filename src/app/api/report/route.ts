import { NextRequest, NextResponse } from "next/server";
import { deviceScopeFromRequest, getWorkspace, listProjects } from "@/lib/server/db";
import { summarize } from "@/lib/qa/issueMerger";
import { applyPatches } from "@/lib/qa/patchService";
import { llmReport } from "@/lib/models/adapters";
import { isRoleConfigured } from "@/lib/models/gateway";
import { buildMonthlyReportData, renderMonthlyReportPdf, renderMonthlyReportWorkbook } from "@/lib/report/monthlyReport";
import type { Issue, QASummary } from "@/types";

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "suggestion", "needs_review"];
const SOURCE_LABEL: Record<string, string> = { caption: "Caption", image: "Ảnh", layout: "Layout" };

function fallbackReport(name: string, summary: QASummary, issues: Issue[], corrected: string): string {
  const lines: string[] = [
    `# QA Report — ${name}`,
    ``,
    `Tạo lúc: ${new Date().toISOString()}`,
    ``,
    `## Tổng quan`,
    ``,
    `- Tổng số issue: **${summary.total_issues}**`,
    `- Lỗi chắc chắn: **${summary.definite_errors}**`,
    `- Gợi ý: ${summary.suggestions}`,
    `- Cần người review: ${summary.needs_review}`,
    ``,
    `| Nguồn | Số issue |`,
    `|---|---:|`,
    ...Object.entries(summary.by_source).map(([s, c]) => `| ${SOURCE_LABEL[s] ?? s} | ${c} |`),
    ``,
  ];

  for (const sev of SEVERITY_ORDER) {
    const group = issues.filter((i) => i.severity === sev && i.status !== "resolved");
    if (group.length === 0) continue;
    lines.push(`## ${sev.toUpperCase()} (${group.length})`, ``);
    for (const i of group) {
      const status = i.status !== "open" ? ` _(${i.status})_` : "";
      lines.push(`- **[${SOURCE_LABEL[i.source_type]}]** \`${i.original}\` → \`${i.suggestion}\` — ${i.reason}${status}`);
    }
    lines.push(``);
  }

  if (corrected.trim()) {
    lines.push(`## Caption đã sửa`, ``, "```", corrected, "```", ``);
  }
  const ignored = issues.filter((i) => i.status === "ignored");
  if (ignored.length) {
    lines.push(`## Đã bỏ qua (${ignored.length})`, ``);
    for (const i of ignored) lines.push(`- \`${i.original}\` — ${i.reason}`);
  }
  return lines.join("\n");
}

export async function GET(req: NextRequest) {
  const scope = deviceScopeFromRequest(req);
  const format = req.nextUrl.searchParams.get("format") ?? "markdown";
  const projectId = req.nextUrl.searchParams.get("project_id")?.trim() || undefined;
  if (!projectId && listProjects(scope).length > 1) {
    return NextResponse.json({ error: "project_id required" }, { status: 400 });
  }
  const ws = getWorkspace(projectId, scope);
  const summary = summarize(ws.issues);
  const { text: corrected } = applyPatches(ws.caption.text, ws.issues, "definite");
  const monthly = buildMonthlyReportData(ws, summary);

  if (format === "json") {
    return NextResponse.json({
      workspace: ws.name,
      generated_at: monthly.generatedAt,
      summary,
      issues: ws.issues,
      corrected_caption: corrected,
      monthly_report: monthly,
    });
  }

  if (format === "pdf") {
    const pdf = await renderMonthlyReportPdf(monthly);
    const body = Buffer.from(pdf);
    return new NextResponse(body, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="monthly-content-qc-report.pdf"`,
        "Content-Length": String(body.byteLength),
      },
    });
  }

  if (format === "xlsx" || format === "excel") {
    const workbook = await renderMonthlyReportWorkbook(monthly);
    const body = Buffer.from(workbook);
    return new NextResponse(body, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="monthly-content-qc-report.xlsx"`,
        "Content-Length": String(body.byteLength),
      },
    });
  }

  let markdown: string | null = null;
  if (isRoleConfigured("report") && req.nextUrl.searchParams.get("llm") === "1") {
    markdown = await llmReport(ws.name, summary, ws.issues, corrected);
  }
  markdown ??= fallbackReport(ws.name, summary, ws.issues, corrected);

  return new NextResponse(markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="qa-report.md"`,
    },
  });
}
