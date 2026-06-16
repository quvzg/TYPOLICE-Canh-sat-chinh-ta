import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Typolice — AI Social Content QA Workspace",
  description:
    "Workspace canvas: upload visuals, arrange Facebook/LinkedIn layouts, paste caption, run AI QA with inline highlights.",
  icons: {
    icon: [{ url: "/typolice-icon.svg", type: "image/svg+xml" }],
    shortcut: [{ url: "/typolice-icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/typolice-icon.svg", type: "image/svg+xml" }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      data-theme="light"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
