"use client";

import { type ReactNode, useState } from "react";
import { apiFetch } from "@/lib/device";

interface ReportDownloadButtonProps {
  format: "pdf" | "xlsx";
  filename: string;
  className: string;
  children: ReactNode;
}

export default function ReportDownloadButton({ format, filename, className, children }: ReportDownloadButtonProps) {
  const [downloading, setDownloading] = useState(false);

  const download = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const res = await apiFetch(`/api/report?format=${format}`);
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
