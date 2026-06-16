import crypto from "crypto";
import { lookup } from "dns/promises";
import jsQR from "jsqr";
import type { Artboard, Asset, Caption, Issue } from "@/types";

type Bbox = NonNullable<Issue["bbox"]>;

export interface LinkSafetyResult {
  issues: Issue[];
  scannedLinks: number;
  scannedQrCodes: number;
  reachableLinks: number;
  threatApiUsed: boolean;
}

interface ExtractedLink {
  raw: string;
  normalized: string | null;
  source_type: Issue["source_type"];
  source_id: string;
  artboard_id: string | null;
  range: Issue["range"];
  bbox: Bbox | null;
  origin: "caption" | "note" | "qr";
  error?: string;
}

interface QrPayload {
  data: string;
  asset: Asset;
  artboardId: string | null;
  bbox: Bbox;
}

interface ProbeResult {
  ok: boolean;
  status: number | null;
  finalUrl: string;
  redirects: string[];
  error?: string;
}

const MAX_QR_DECODE_DIMENSION = 2200;
const URL_TIMEOUT_MS = 6500;
const MAX_REDIRECTS = 5;
const PRIMARY_CAPTION_ARTBOARD_ID = "artboard_caption";

const SHORTENER_HOSTS = new Set([
  "bit.ly",
  "tinyurl.com",
  "t.co",
  "goo.gl",
  "ow.ly",
  "rebrand.ly",
  "cutt.ly",
  "shorturl.at",
  "lnkd.in",
  "s.id",
  "is.gd",
  "buff.ly",
]);

const SAFE_SCHEMES = new Set(["http:", "https:"]);

const URL_RE = /https?:\/\/[^\s<>"'`]+|www\.[^\s<>"'`]+|(?<![@\p{L}\p{N}_-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com\.vn|net\.vn|org\.vn|edu\.vn|gov\.vn|com|net|org|vn|ai|io|co|dev|app|xyz|me|edu|gov|info|biz|shop|site|online|cloud|link|ly|gg)(?:\/[^\s<>"'`]*)?/giu;

function issueId(parts: string[]) {
  return `issue_link_${crypto.createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 12)}`;
}

function artboardKind(ab: Artboard) {
  return ab.kind ?? (ab.format === "caption" ? "caption" : ab.format === "note" ? "note" : "visual");
}

function normalizeHostname(hostname: string) {
  return hostname.toLowerCase().replace(/^www\./, "");
}

function trimCandidate(raw: string): { value: string; lead: number } {
  let value = raw;
  let lead = 0;
  while (/^[<("'\[]/.test(value)) {
    value = value.slice(1);
    lead += 1;
  }
  while (/[)\].,;:!?"'>]+$/.test(value)) {
    value = value.slice(0, -1);
  }
  return { value, lead };
}

function normalizeUrl(raw: string): { normalized: string | null; error?: string } {
  const value = raw.trim();
  if (!value) return { normalized: null, error: "empty" };

  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(value);
  const candidate = hasScheme ? value : `https://${value}`;

  try {
    const url = new URL(candidate);
    if (!SAFE_SCHEMES.has(url.protocol)) {
      return { normalized: null, error: `unsupported_scheme:${url.protocol}` };
    }
    return { normalized: url.toString() };
  } catch {
    return { normalized: null, error: "invalid_url" };
  }
}

function extractLinksFromText(
  text: string,
  source_type: Issue["source_type"],
  source_id: string,
  artboard_id: string | null,
  origin: ExtractedLink["origin"]
): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  for (const match of text.matchAll(URL_RE)) {
    const rawMatch = match[0];
    const { value, lead } = trimCandidate(rawMatch);
    if (!value) continue;
    const start = match.index! + lead;
    const parsed = normalizeUrl(value);
    links.push({
      raw: value,
      normalized: parsed.normalized,
      source_type,
      source_id,
      artboard_id,
      range: source_type === "caption" ? { start, end: start + value.length } : null,
      bbox: null,
      origin,
      error: parsed.error,
    });
  }
  return links;
}

function isIpv4Private(hostname: string) {
  const parts = hostname.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isIpv6Private(hostname: string) {
  const h = hostname.toLowerCase();
  return h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80");
}

function isPrivateOrLocalHost(hostname: string) {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    isIpv4Private(host) ||
    isIpv6Private(host)
  );
}

function isPrivateAddress(address: string) {
  return isIpv4Private(address) || isIpv6Private(address);
}

async function resolvesToPrivate(hostname: string): Promise<boolean> {
  if (isPrivateOrLocalHost(hostname)) return true;
  try {
    const records = await lookup(hostname, { all: true, verbatim: false });
    return records.some((record) => isPrivateAddress(record.address));
  } catch {
    return false;
  }
}

function createIssue(
  link: ExtractedLink,
  severity: Issue["severity"],
  reason: string,
  opts: { suggestion?: string; definite?: boolean; confidence?: number; createdBy?: string } = {}
): Issue {
  const suggestion = opts.suggestion ?? link.raw;
  return {
    issue_id: issueId([
      link.source_type,
      link.source_id,
      link.artboard_id ?? "",
      link.raw,
      suggestion,
      reason,
    ]),
    source_type: link.source_type,
    source_id: link.source_id,
    artboard_id: link.artboard_id,
    box_id: null,
    type: "link_safety",
    severity,
    original: link.raw,
    suggestion,
    reason,
    confidence: opts.confidence ?? 0.86,
    is_definite_error: opts.definite ?? (severity === "critical" || severity === "high"),
    range: link.range,
    bbox: link.bbox,
    status: "open",
    created_by: opts.createdBy ?? (link.origin === "qr" ? "qr_safety_checker" : "link_safety_checker"),
  };
}

async function fetchOnce(url: string, method: "HEAD" | "GET"): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), URL_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method,
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "User-Agent": "Typolice-LinkSafety/1.0",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        ...(method === "GET" ? { Range: "bytes=0-0" } : {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function probeUrl(url: string): Promise<ProbeResult> {
  const redirects: string[] = [];
  let current = url;
  let method: "HEAD" | "GET" = "HEAD";

  for (let attempt = 0; attempt <= MAX_REDIRECTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetchOnce(current, method);
    } catch (err) {
      if (method === "HEAD") {
        method = "GET";
        continue;
      }
      return {
        ok: false,
        status: null,
        finalUrl: current,
        redirects,
        error: err instanceof Error ? err.message : "fetch_failed",
      };
    }

    if ((response.status === 405 || response.status === 501) && method === "HEAD") {
      method = "GET";
      continue;
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        return { ok: false, status: response.status, finalUrl: current, redirects, error: "redirect_without_location" };
      }
      const next = new URL(location, current).toString();
      redirects.push(next);
      current = next;
      method = "HEAD";
      continue;
    }

    return {
      ok: response.status >= 200 && response.status < 400,
      status: response.status,
      finalUrl: current,
      redirects,
    };
  }

  return { ok: false, status: null, finalUrl: current, redirects, error: "too_many_redirects" };
}

async function checkWebRisk(url: string): Promise<{ used: boolean; threats: string[] }> {
  const key = process.env.WEB_RISK_API_KEY || process.env.GOOGLE_WEB_RISK_API_KEY;
  if (!key) return { used: false, threats: [] };

  const params = new URLSearchParams();
  params.append("uri", url);
  params.append("key", key);
  for (const type of ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE"]) {
    params.append("threatTypes", type);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), URL_TIMEOUT_MS);
  try {
    const response = await fetch(`https://webrisk.googleapis.com/v1/uris:search?${params.toString()}`, {
      signal: controller.signal,
    });
    if (!response.ok) return { used: true, threats: [] };
    const data = await response.json() as { threat?: { threatTypes?: string[] } };
    return { used: true, threats: data.threat?.threatTypes ?? [] };
  } catch {
    return { used: true, threats: [] };
  } finally {
    clearTimeout(timer);
  }
}

async function issuesForLink(link: ExtractedLink): Promise<{ issues: Issue[]; reachable: boolean; threatApiUsed: boolean }> {
  const issues: Issue[] = [];
  if (!link.normalized) {
    const scheme = link.error?.startsWith("unsupported_scheme:") ? link.error.split(":")[1] : null;
    issues.push(createIssue(
      link,
      scheme ? "critical" : "high",
      scheme
        ? `Link dùng scheme không an toàn (${scheme}). Chỉ nên dùng http/https khi publish.`
        : "Link không parse được thành URL hợp lệ.",
      { suggestion: "Dùng URL https:// hợp lệ.", definite: true, confidence: 0.94 }
    ));
    return { issues, reachable: false, threatApiUsed: false };
  }

  const url = new URL(link.normalized);
  const host = normalizeHostname(url.hostname);

  if (url.username || url.password) {
    issues.push(createIssue(
      link,
      "high",
      "URL chứa username/password. Không nên publish link có thông tin đăng nhập trong URL.",
      { definite: true, confidence: 0.94 }
    ));
  }

  if (isPrivateOrLocalHost(url.hostname) || await resolvesToPrivate(url.hostname)) {
    issues.push(createIssue(
      link,
      "high",
      "Link trỏ tới localhost, IP nội bộ hoặc host private; người xem bên ngoài sẽ không mở được an toàn.",
      { definite: true, confidence: 0.94 }
    ));
    return { issues, reachable: false, threatApiUsed: false };
  }

  if (url.protocol === "http:") {
    const httpsUrl = new URL(url.toString());
    httpsUrl.protocol = "https:";
    issues.push(createIssue(
      link,
      "medium",
      "Link đang dùng HTTP. Nên dùng HTTPS để tránh cảnh báo bảo mật khi publish.",
      { suggestion: httpsUrl.toString(), definite: false, confidence: 0.86 }
    ));
  }

  if (host.includes("xn--")) {
    issues.push(createIssue(
      link,
      "needs_review",
      "Domain dùng punycode/IDN, dễ gây nhầm lẫn nếu là link public. Cần kiểm tra lại domain hiển thị.",
      { definite: false, confidence: 0.72 }
    ));
  }

  if (SHORTENER_HOSTS.has(host)) {
    issues.push(createIssue(
      link,
      "needs_review",
      "Link dùng URL shortener. Cần review vì người xem không thấy domain đích trước khi mở.",
      { definite: false, confidence: 0.82 }
    ));
  }

  const threat = await checkWebRisk(link.normalized);
  if (threat.threats.length > 0) {
    issues.push(createIssue(
      link,
      "critical",
      `Threat API flag URL này: ${threat.threats.join(", ")}.`,
      { definite: true, confidence: 0.98 }
    ));
    return { issues, reachable: false, threatApiUsed: threat.used };
  }

  const probe = await probeUrl(link.normalized);
  if (!probe.ok) {
    const statusText = probe.status ? `HTTP ${probe.status}` : probe.error ?? "network error";
    const severity: Issue["severity"] = probe.status === 401 || probe.status === 403 ? "needs_review" : "high";
    issues.push(createIssue(
      link,
      severity,
      `Link chưa mở ổn trong server check (${statusText}). Cần kiểm tra lại trước khi publish.`,
      { definite: severity === "high", confidence: 0.84 }
    ));
  }

  if (probe.redirects.length > 0) {
    const final = new URL(probe.finalUrl);
    const finalHost = normalizeHostname(final.hostname);
    if (finalHost !== host) {
      issues.push(createIssue(
        link,
        "needs_review",
        `Link redirect sang domain khác (${finalHost}). Cần xác nhận đây là domain đích mong muốn.`,
        { suggestion: probe.finalUrl, definite: false, confidence: 0.82 }
      ));
    }
  }

  return { issues, reachable: probe.ok, threatApiUsed: threat.used };
}

async function decodeQrPayload(filePath: string, asset: Asset, artboardId: string | null): Promise<QrPayload | null> {
  const { default: sharp } = await import("sharp");
  const image = sharp(filePath).rotate().resize({
    width: MAX_QR_DECODE_DIMENSION,
    height: MAX_QR_DECODE_DIMENSION,
    fit: "inside",
    withoutEnlargement: true,
  });
  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (!info.width || !info.height) return null;
  const code = jsQR(new Uint8ClampedArray(data), info.width, info.height, { inversionAttempts: "attemptBoth" });
  if (!code?.data) return null;

  const sx = asset.width > 0 ? asset.width / info.width : 1;
  const sy = asset.height > 0 ? asset.height / info.height : 1;
  const points = [
    code.location.topLeftCorner,
    code.location.topRightCorner,
    code.location.bottomRightCorner,
    code.location.bottomLeftCorner,
  ];
  const xs = points.map((point) => point.x * sx);
  const ys = points.map((point) => point.y * sy);
  const pad = 8;
  const bbox: Bbox = [
    Math.max(0, Math.round(Math.min(...xs) - pad)),
    Math.max(0, Math.round(Math.min(...ys) - pad)),
    Math.min(asset.width || Number.MAX_SAFE_INTEGER, Math.round(Math.max(...xs) + pad)),
    Math.min(asset.height || Number.MAX_SAFE_INTEGER, Math.round(Math.max(...ys) + pad)),
  ];

  return { data: code.data.trim(), asset, artboardId, bbox };
}

function linkFromQr(qr: QrPayload): ExtractedLink {
  const direct = normalizeUrl(qr.data);
  if (direct.normalized) {
    return {
      raw: qr.data,
      normalized: direct.normalized,
      source_type: "image",
      source_id: qr.asset.id,
      artboard_id: qr.artboardId,
      range: null,
      bbox: qr.bbox,
      origin: "qr",
    };
  }

  const nested = extractLinksFromText(qr.data, "image", qr.asset.id, qr.artboardId, "qr")[0];
  if (nested) return { ...nested, raw: nested.raw, bbox: qr.bbox };

  return {
    raw: qr.data,
    normalized: null,
    source_type: "image",
    source_id: qr.asset.id,
    artboard_id: qr.artboardId,
    range: null,
    bbox: qr.bbox,
    origin: "qr",
    error: direct.error ?? "qr_payload_not_url",
  };
}

export async function runLinkSafetyChecks(input: {
  caption: Caption;
  artboards: Artboard[];
  assets: Asset[];
  getAssetFilePath: (asset: Asset) => string;
}): Promise<LinkSafetyResult> {
  const issues: Issue[] = [];
  const links: ExtractedLink[] = [];

  links.push(...extractLinksFromText(input.caption.text, "caption", input.caption.id, null, "caption"));

  for (const artboard of input.artboards) {
    const kind = artboardKind(artboard);
    if (kind === "caption" && artboard.id !== PRIMARY_CAPTION_ARTBOARD_ID && artboard.text?.trim()) {
      links.push(...extractLinksFromText(artboard.text, "caption", artboard.id, artboard.id, "caption"));
    }
    if (kind === "note" && artboard.text?.trim()) {
      links.push(...extractLinksFromText(artboard.text, "layout", artboard.id, artboard.id, "note"));
    }
  }

  const artboardByAsset = new Map<string, string | null>();
  for (const asset of input.assets) {
    const ab = input.artboards.find((artboard) => artboard.layers.some((layer) => layer.asset_id === asset.id));
    artboardByAsset.set(asset.id, ab?.id ?? null);
  }

  const qrPayloads: QrPayload[] = [];
  for (const asset of input.assets) {
    try {
      const qr = await decodeQrPayload(input.getAssetFilePath(asset), asset, artboardByAsset.get(asset.id) ?? null);
      if (qr) qrPayloads.push(qr);
    } catch {
      // QR check is best-effort. Broken image files are handled by upload/OCR paths.
    }
  }
  links.push(...qrPayloads.map(linkFromQr));

  const uniqueLinks = new Map<string, ExtractedLink>();
  for (const link of links) {
    const key = [
      link.source_type,
      link.source_id,
      link.artboard_id ?? "",
      link.range?.start ?? "",
      link.normalized ?? link.raw,
      link.origin,
    ].join("|");
    uniqueLinks.set(key, link);
  }

  let reachableLinks = 0;
  let threatApiUsed = false;
  for (const link of uniqueLinks.values()) {
    const result = await issuesForLink(link);
    issues.push(...result.issues);
    if (result.reachable) reachableLinks += 1;
    threatApiUsed = threatApiUsed || result.threatApiUsed;
  }

  return {
    issues,
    scannedLinks: uniqueLinks.size,
    scannedQrCodes: qrPayloads.length,
    reachableLinks,
    threatApiUsed,
  };
}
