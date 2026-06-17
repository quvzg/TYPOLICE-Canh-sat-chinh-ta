"use client";

import { type ReactNode, useState } from "react";
import { apiFetch } from "@/lib/device";
import { useQAStore } from "@/lib/store";

interface ReportDownloadButtonProps {
  format: "pdf" | "xlsx";
  filename: string;
  className: string;
  children: ReactNode;
}

export default function ReportDownloadButton({ format, filename, className, children }: ReportDownloadButtonProps) {
  const [downloading, setDownloading] = useState(false);
  const activeProjectId = useQAStore((s) => s.activeProjectId);

  const download = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const params = new URLSearchParams({ format });
      if (activeProjectId) params.set("project_id", activeProjectId);
      const res = await apiFetch(`/api/report?${params.toString()}`);
      if (!res.ok) throw new Error("download failed");
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
    } catch {
      window.alert("Chưa tải được report. Hãy thử lại sau khi app tải xong dữ liệu.");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <button type="button" onClick={() => void download()} disabled={downloading} className={className}>
      {downloading ? "Downloading..." : children}
    </button>
  );
}
