import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase, supabaseConfigured } from "./supabaseClient";

// ── Types ─────────────────────────────────────────────────────────────────────
type HttpLink = { id: string; title: string; url: string; created_date?: string };
type Toast = { id: number; msg: string; kind: "ok" | "error" };
type Confirmation = { title: string; body: string; danger?: boolean; onConfirm: () => void } | null;
type LinkGroup = { label: string; items: HttpLink[] };

const PRIO_KEY = "link-vault-priority";

// ── Helpers ───────────────────────────────────────────────────────────────────
function splitTag(v: string): { url: string; tag: string } {
  const s = (v || "").trim();
  const i = s.indexOf("|");
  if (i === -1) return { url: s, tag: "" };
  return { url: s.slice(0, i).trim(), tag: s.slice(i + 1).trim() };
}
function isTaggedLink(v: string) {
  return (v || "").includes("|");
}
function plainUrlOf(v: string) {
  return splitTag(v).url;
}
function tagOf(v: string) {
  return splitTag(v).tag;
}
function buildTagged(url: string, tag: string) {
  const u = (url || "").trim();
  const t = (tag || "").trim();
  return t ? `${u}|${t}` : u;
}
function isValidHttpLink(v: string) {
  const { url } = splitTag(v);
  return /^https?:\/\/[^\s]+$/i.test(url);
}

function isOpaqueIdSegment(s: string): boolean {
  if (!s) return false;
  if (/^\d+$/.test(s)) return true; 
  if (/^[0-9a-f]{16,}$/i.test(s)) return true; 
  const words = s.replace(/[._-]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (s.length >= 14 && words.length && words.every((w) => /^[0-9a-f]+$/i.test(w) || /^\d+$/.test(w))) return true;
  return false;
}

function isSlugLikeSegment(s: string): boolean {
  if (!s) return false;
  if (s.length < 6 || s.length > 40) return false;
  if (/[-_.+\s]/.test(s)) return false; 
  const hasLower = /[a-z]/.test(s);
  const hasUpper = /[A-Z]/.test(s);
  const hasDigit = /\d/.test(s);
  if (hasLower && hasUpper) return true;
  if (hasDigit && (hasLower || hasUpper) && !/^[a-z]+\d{1,4}$/i.test(s)) return true;
  return false;
}

function parseHttpLinkTitle(url: string) {
  if (!url) return "";
  const plain = plainUrlOf(url);
  try {
    const u = new URL(plain.trim());
    const GENERIC = new Set([
      "watch", "view", "video", "videos", "stream", "streaming", "play", "embed",
      "link", "links", "media", "content", "item", "post", "article",
      "u", "d", "f", "s", "e", "dl", "get", "go",
      "file", "files", "download", "downloads", "file-download",
      "share", "shared", "attachment", "attachments", "uploads", "upload",
      "api", "cdn",
    ]);
    const segments = u.pathname.split("/").filter(Boolean);
    if (!segments.length) return u.hostname.replace(/^www\./i, "");

    const decodedSegs = segments.map((seg, i) => {
      let s = i === segments.length - 1 ? seg.replace(/\.(html?|php|aspx?|jsp|m3u8|mp4|mkv|webm|json|xml)$/i, "") : seg;
      try { s = decodeURIComponent(s); } catch { /* leave as-is if malformed escape */ }
      return s;
    });

    const last = decodedSegs[decodedSegs.length - 1];
    const lastWordCount = last.replace(/[-_+.]+/g, " ").trim().split(/\s+/).filter(Boolean).length;
    let chosen = [last];
    if (isOpaqueIdSegment(last) || isSlugLikeSegment(last) || lastWordCount < 3) {
      const lookback = Math.max(0, decodedSegs.length - 6);
      for (let i = decodedSegs.length - 2; i >= lookback; i--) {
        const seg = decodedSegs[i];
        if (!seg || isOpaqueIdSegment(seg) || isSlugLikeSegment(seg) || GENERIC.has(seg.toLowerCase())) continue;
        chosen = [seg, ...chosen];
        break;
      }
    }

    let title = chosen.join(" ").replace(/[-_+.]+/g, " ").replace(/\s+/g, " ").trim();
    if (!title) return u.hostname.replace(/^www\./i, "");

    title = title
      .split(" ")
      .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
      .join(" ");
    title = title.replace(/\bs(\d{1,4})e(\d{1,4})\b/i, (_m, s, e) => `S${s}E${e}`);
    return title;
  } catch {
    return "";
  }
}

function isUrlTitleWeak(title: string, url: string): boolean {
  if (!title) return true;
  const plain = plainUrlOf(url);
  try {
    const u = new URL(plain.trim());
    const host = u.hostname.replace(/^www\./i, "");
    if (title.toLowerCase() === host.toLowerCase()) return true;
    const segs = u.pathname.split("/").filter(Boolean);
    const lastRaw = segs[segs.length - 1] || "";
    let lastDecoded = lastRaw.replace(/\.(html?|php|aspx?|jsp|m3u8|mp4|mkv|webm|json|xml)$/i, "");
    try { lastDecoded = decodeURIComponent(lastDecoded); } catch { /* keep raw */ }
    if (lastDecoded && (isOpaqueIdSegment(lastDecoded) || isSlugLikeSegment(lastDecoded))) return true;
  } catch { /* invalid URL */ }
  const words = title.replace(/[^\w\s]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return true;
  if (isOpaqueIdSegment(title.replace(/\s+/g, ""))) return true;
  return false;
}

function parseContentDispositionFilename(header: string | null | undefined): string | null {
  if (!header) return null;
  const starMatch = header.match(/filename\*\s*=\s*[^']*''([^;]+)/i);
  if (starMatch) {
    try { return decodeURIComponent(starMatch[1].trim().replace(/^"|"$/g, "")); } catch { /* fall through */ }
  }
  const plainMatch = header.match(/filename\s*=\s*"?([^";]+)"?/i);
  if (plainMatch) return plainMatch[1].trim().replace(/^"|"$/g, "");
  return null;
}

function filenameToTitle(filename: string): string {
  let base = filename.replace(/\.(html?|php|aspx?|jsp|m3u8|mp4|mkv|webm|avi|mov|m4v|json|xml)$/i, "");
  try { base = decodeURIComponent(base); } catch { /* leave as-is if malformed escape */ }
  let title = base.replace(/[-_+.]+/g, " ").replace(/\s+/g, " ").trim();
  if (!title) return "";
  title = title.split(" ").map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ");
  title = title.replace(/\bs(\d{1,4})e(\d{1,4})\b/i, (_m, s, e) => `S${s}E${e}`);
  return title;
}

async function fetchContentDispositionTitle(url: string, timeoutMs = 4000): Promise<string | null> {
  const target = plainUrlOf(url);
  const withTimeout = () => (typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(timeoutMs) : undefined);

  try {
    const res = await fetch(target, { method: "HEAD", mode: "cors", redirect: "follow", signal: withTimeout() });
    const name = parseContentDispositionFilename(res.headers.get("content-disposition"));
    if (name) return filenameToTitle(name);
  } catch { /* likely blocked by CORS */ }

  try {
    const proxyTimeoutMs = Math.max(timeoutMs, 9000);
    const withProxyTimeout = () =>
      typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(proxyTimeoutMs) : undefined;
    const proxied = await fetch(`/api/resolve-filename?url=${encodeURIComponent(target)}`, { signal: withProxyTimeout() });
    if (proxied.ok) {
      const data = await proxied.json();
      if (data?.filename) return filenameToTitle(data.filename);
      if (data?.title && typeof data.title === "string" && data.title.trim()) return data.title.trim();
    }
  } catch { /* proxy unavailable */ }

  return null;
}

function extractHttpLinks(text: string): string[] {
  if (!text) return [];
  return text
    .split(/(?=https?:\/\/)/gi)
    .map((s) => s.trim().replace(/[\s,;]+$/, ""))
    .filter((s) => /^https?:\/\//i.test(s));
}

function parseSeasonEpisode(title: string): { season: number | null; episode: number | null } | null {
  if (!title) return null;
  let m = title.match(/s(\d{1,4})[\s._-]*e(\d{1,4})/i);
  if (m) return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) };
  m = title.match(/\b(\d{1,2})x(\d{1,3})\b/i);
  if (m) return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) };
  m = title.match(/\bepisode[\s._-]*(\d{1,4})\b/i);
  if (m) return { season: null, episode: parseInt(m[1], 10) };
  m = title.match(/\bep[\s._-]*(\d{1,4})\b/i);
  if (m) return { season: null, episode: parseInt(m[1], 10) };
  m = title.match(/\b(?:s|season)[\s._-]*(\d{1,4})(?!\d)/i);
  if (m) return { season: parseInt(m[1], 10), episode: null };
  return null;
}

function stripShowName(title: string) {
  if (!title) return "";
  let name = title.replace(/[._]+/g, " ");
  const seMatch = name.match(/\b(s\d{1,4}[\s._-]*e\d{1,4}|\d{1,2}x\d{1,4}|episode[\s._-]*\d{1,4}|ep[\s._-]*\d{1,4}|(?:s|season)[\s._-]*\d{1,4})(?!\d)/i);
  if (seMatch && seMatch.index !== undefined) name = name.slice(0, seMatch.index);
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

function episodeKey(title: string) {
  const show = stripShowName(title);
  const se = parseSeasonEpisode(title);
  if (se) {
    const seasonStr = se.season !== null ? `s${String(se.season).padStart(2, "0")}` : "";
    const epStr = se.episode !== null ? `e${String(se.episode).padStart(2, "0")}` : "";
    return `${show}|${seasonStr}${epStr}`;
  }
  return show || title.toLowerCase().trim();
}

function splitIntoGroups<T>(arr: T[], splitCount: number, perGroup: number): T[][] {
  if (perGroup && perGroup > 0) {
    const g: T[][] = [];
    for (let i = 0; i < arr.length; i += perGroup) g.push(arr.slice(i, i + perGroup));
    return g;
  }
  if (splitCount && splitCount >= 2) {
    const g: T[][] = [];
    const size = Math.ceil(arr.length / splitCount);
    for (let i = 0; i < splitCount; i++) {
      const c = arr.slice(i * size, (i + 1) * size);
      if (c.length > 0) g.push(c);
    }
    return g;
  }
  return [arr];
}

function splitByKeywords(arr: HttpLink[], keywords: string[]): LinkGroup[] {
  const kws = keywords.map((k) => k.trim()).filter(Boolean);
  if (!kws.length) return [{ label: "Group 1", items: arr }];
  const buckets: LinkGroup[] = kws.map((k) => ({ label: k, items: [] }));
  const ungrouped: HttpLink[] = [];
  for (const item of arr) {
    const hay = `${item.title} ${item.url}`.toLowerCase();
    const idx = kws.findIndex((k) => hay.includes(k.toLowerCase()));
    if (idx >= 0) buckets[idx].items.push(item);
    else ungrouped.push(item);
  }
  buckets.push({ label: "Ungrouped", items: ungrouped });
  return buckets;
}

function urlKeyOf(u: string) {
  return plainUrlOf(u).toLowerCase().replace(/\/+$/, "");
}

// ── API (Supabase) — HTTP links ─────────────────────────────────────────────
function rowToHttpLink(r: any): HttpLink {
  return {
    id: String(r.id),
    title: r.title ?? "",
    url: r.url ?? "",
    created_date: r.created_at,
  };
}

async function dbListHttpLinks(): Promise<{ list: HttpLink[] }> {
  const { data, error } = await supabase
    .from("http_links")
    .select("id, title, url, created_at")
    .order("created_at", { ascending: false })
    .limit(10000);
  if (error) throw new Error(error.message);
  return { list: (data || []).map(rowToHttpLink) };
}

async function dbAddHttpLink(title: string, url: string): Promise<HttpLink> {
  const { data, error } = await supabase
    .from("http_links")
    .insert({ title: title.slice(0, 1000), url: url.slice(0, 4000) })
    .select("id, title, url, created_at")
    .single();
  if (error) throw new Error(error.message);
  return rowToHttpLink(data);
}

async function dbAddHttpLinksBulk(records: { title: string; url: string }[]): Promise<{ list: HttpLink[] }> {
  if (!records.length) return { list: [] };
  const payload = records.map((r) => ({
    title: String(r.title ?? "").slice(0, 1000),
    url: String(r.url ?? "").slice(0, 4000),
  }));
  const { data, error } = await supabase.from("http_links").insert(payload).select("id, title, url, created_at");
  if (error) throw new Error(error.message);
  return { list: (data || []).map(rowToHttpLink) };
}

async function dbUpdateHttpLinkUrl(id: string, url: string): Promise<void> {
  const { error } = await supabase.from("http_links").update({ url: url.slice(0, 4000) }).eq("id", Number(id));
  if (error) throw new Error(error.message);
}

async function dbUpdateHttpLinksUrlsBulk(updates: { id: string; url: string }[]): Promise<void> {
  if (!updates.length) return;
  const CHUNK_SIZE = 500;
  for (let i = 0; i < updates.length; i += CHUNK_SIZE) {
    const chunk = updates.slice(i, i + CHUNK_SIZE).map((u) => ({ id: Number(u.id), url: u.url.slice(0, 4000) }));
    const { error } = await supabase.from("http_links").upsert(chunk, { onConflict: "id" });
    if (error) throw new Error(error.message);
  }
}

async function dbDeleteHttpLink(id: string): Promise<void> {
  const { error } = await supabase.from("http_links").delete().eq("id", Number(id));
  if (error) throw new Error(error.message);
}

async function dbDeleteHttpLinksBulk(ids: string[]): Promise<void> {
  const numIds = ids.map((v) => Number(v)).filter((n) => Number.isFinite(n));
  if (!numIds.length) return;
  const { error } = await supabase.from("http_links").delete().in("id", numIds);
  if (error) throw new Error(error.message);
}

// ── Background ornaments ──────────────────────────────────────────────────────
function OceanBg() {
  return (
    <>
      <div className="orb orb-1" />
      <div className="orb orb-2" />
      <div className="orb orb-3" />
      {Array.from({ length: 24 }).map((_, i) => (
        <span key={i} className="bubble-bg" aria-hidden>{i % 3 === 0 ? "🫧" : i % 3 === 1 ? "🐚" : "🐠"}</span>
      ))}
      {Array.from({ length: 7 }).map((_, i) => (
        <span key={i} className="mermaid-bg" aria-hidden>{i % 2 === 0 ? "🧜‍♀️" : "🧜‍♂️"}</span>
      ))}
    </>
  );
}

// ── Inline SVG icons ──────────────────────────────────────────────────────────
const I = {
  Mermaid: () => (<svg viewBox="0 0 24 24Here is the updated code. Two main adjustments were made to solve both issues:

1.  **Horizontal Scrolling:** Added `style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}` to the `.action-bar`, `.add-btn-row`, and `.dedupe-mode-row` containers. This forces the buttons to wrap into multiple rows naturally on narrower screens rather than spilling off the side. 
2.  **postMessage Duplication:** The issue was a React closure/race condition. If a bookmarklet fired multiple `postMessage` events rapidly, the `allLinks` state wouldn't have time to update between messages, causing the script to think the link was still "new". This is fixed by using a synchronous `useRef` (`processedUrlsRef`) to instantly track incoming links across renders, completely blocking rapid-fire duplicates.

You can safely copy and replace your entire `App.tsx` file with this:

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase, supabaseConfigured } from "./supabaseClient";

// ── Types ─────────────────────────────────────────────────────────────────────
type HttpLink = { id: string; title: string; url: string; created_date?: string };
type Toast = { id: number; msg: string; kind: "ok" | "error" };
type Confirmation = { title: string; body: string; danger?: boolean; onConfirm: () => void } | null;
type LinkGroup = { label: string; items: HttpLink[] };

const PRIO_KEY = "link-vault-priority";

// ── Helpers ───────────────────────────────────────────────────────────────────
function splitTag(v: string): { url: string; tag: string } {
  const s = (v || "").trim();
  const i = s.indexOf("|");
  if (i === -1) return { url: s, tag: "" };
  return { url: s.slice(0, i).trim(), tag: s.slice(i + 1).trim() };
}
function isTaggedLink(v: string) {
  return (v || "").includes("|");
}
function plainUrlOf(v: string) {
  return splitTag(v).url;
}
function tagOf(v: string) {
  return splitTag(v).tag;
}
function buildTagged(url: string, tag: string) {
  const u = (url || "").trim();
  const t = (tag || "").trim();
  return t ? `${u}|${t}` : u;
}
function isValidHttpLink(v: string) {
  const { url } = splitTag(v);
  return /^https?:\/\/[^\s]+$/i.test(url);
}

function isOpaqueIdSegment(s: string): boolean {
  if (!s) return false;
  if (/^\d+$/.test(s)) return true; 
  if (/^[0-9a-f]{16,}$/i.test(s)) return true; 
  const words = s.replace(/[._-]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (s.length >= 14 && words.length && words.every((w) => /^[0-9a-f]+$/i.test(w) \vert{}\vert{} /^\d+$/.test(w))) return true;
  return false;
}

function isSlugLikeSegment(s: string): boolean {
  if (!s) return false;
  if (s.length < 6 || s.length > 40) return false;
  if (/[-_.+\s]/.test(s)) return false; 
  const hasLower = /[a-z]/.test(s);
  const hasUpper = /[A-Z]/.test(s);
  const hasDigit = /\d/.test(s);
  if (hasLower && hasUpper) return true;
  if (hasDigit && (hasLower || hasUpper) && !/^[a-z]+\d{1,4}$/i.test(s)) return true;
  return false;
}

function parseHttpLinkTitle(url: string) {
  if (!url) return "";
  const plain = plainUrlOf(url);
  try {
    const u = new URL(plain.trim());
    const GENERIC = new Set([
      "watch", "view", "video", "videos", "stream", "streaming", "play", "embed",
      "link", "links", "media", "content", "item", "post", "article",
      "u", "d", "f", "s", "e", "dl", "get", "go",
      "file", "files", "download", "downloads", "file-download",
      "share", "shared", "attachment", "attachments", "uploads", "upload",
      "api", "cdn",
    ]);
    const segments = u.pathname.split("/").filter(Boolean);
    if (!segments.length) return u.hostname.replace(/^www\./i, "");

    const decodedSegs = segments.map((seg, i) => {
      let s = i === segments.length - 1 ? seg.replace(/\.(html?|php|aspx?|jsp|m3u8|mp4|mkv|webm|json|xml)$/i, "") : seg;
      try { s = decodeURIComponent(s); } catch { /* leave as-is */ }
      return s;
    });

    const last = decodedSegs[decodedSegs.length - 1];
    const lastWordCount = last.replace(/[-_+.]+/g, " ").trim().split(/\s+/).filter(Boolean).length;
    let chosen = [last];
    if (isOpaqueIdSegment(last) || isSlugLikeSegment(last) || lastWordCount < 3) {
      const lookback = Math.max(0, decodedSegs.length - 6);
      for (let i = decodedSegs.length - 2; i >= lookback; i--) {
        const seg = decodedSegs[i];
        if (!seg || isOpaqueIdSegment(seg) || isSlugLikeSegment(seg) || GENERIC.has(seg.toLowerCase())) continue;
        chosen = [seg, ...chosen];
        break;
      }
    }

    let title = chosen.join(" ").replace(/[-_+.]+/g, " ").replace(/\s+/g, " ").trim();
    if (!title) return u.hostname.replace(/^www\./i, "");

    title = title
      .split(" ")
      .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
      .join(" ");
    title = title.replace(/\bs(\d{1,4})e(\d{1,4})\b/i, (_m, s, e) => `S${s}E${e}`);
    return title;
  } catch {
    return "";
  }
}

function isUrlTitleWeak(title: string, url: string): boolean {
  if (!title) return true;
  const plain = plainUrlOf(url);
  try {
    const u = new URL(plain.trim());
    const host = u.hostname.replace(/^www\./i, "");
    if (title.toLowerCase() === host.toLowerCase()) return true;
    const segs = u.pathname.split("/").filter(Boolean);
    const lastRaw = segs[segs.length - 1] || "";
    let lastDecoded = lastRaw.replace(/\.(html?|php|aspx?|jsp|m3u8|mp4|mkv|webm|json|xml)$/i, "");
    try { lastDecoded = decodeURIComponent(lastDecoded); } catch { /* keep raw */ }
    if (lastDecoded && (isOpaqueIdSegment(lastDecoded) || isSlugLikeSegment(lastDecoded))) return true;
  } catch { /* invalid URL */ }
  const words = title.replace(/[^\w\s]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return true;
  if (isOpaqueIdSegment(title.replace(/\s+/g, ""))) return true;
  return false;
}

function parseContentDispositionFilename(header: string | null | undefined): string | null {
  if (!header) return null;
  const starMatch = header.match(/filename\*\s*=\s*[^']*''([^;]+)/i);
  if (starMatch) {
    try { return decodeURIComponent(starMatch[1].trim().replace(/^"|"$/g, "")); } catch { /* fall through */ }
  }
  const plainMatch = header.match(/filename\s*=\s*"?([^";]+)"?/i);
  if (plainMatch) return plainMatch[1].trim().replace(/^"|"$/g, "");
  return null;
}

function filenameToTitle(filename: string): string {
  let base = filename.replace(/\.(html?|php|aspx?|jsp|m3u8|mp4|mkv|webm|avi|mov|m4v|json|xml)$/i, "");
  try { base = decodeURIComponent(base); } catch { /* leave as-is */ }
  let title = base.replace(/[-_+.]+/g, " ").replace(/\s+/g, " ").trim();
  if (!title) return "";
  title = title.split(" ").map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ");
  title = title.replace(/\bs(\d{1,4})e(\d{1,4})\b/i, (_m, s, e) => `S${s}E${e}`);
  return title;
}

async function fetchContentDispositionTitle(url: string, timeoutMs = 4000): Promise<string | null> {
  const target = plainUrlOf(url);
  const withTimeout = () => (typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(timeoutMs) : undefined);

  try {
    const res = await fetch(target, { method: "HEAD", mode: "cors", redirect: "follow", signal: withTimeout() });
    const name = parseContentDispositionFilename(res.headers.get("content-disposition"));
    if (name) return filenameToTitle(name);
  } catch { /* likely blocked by CORS */ }

  try {
    const proxyTimeoutMs = Math.max(timeoutMs, 9000);
    const withProxyTimeout = () =>
      typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(proxyTimeoutMs) : undefined;
    const proxied = await fetch(`/api/resolve-filename?url=${encodeURIComponent(target)}`, { signal: withProxyTimeout() });
    if (proxied.ok) {
      const data = await proxied.json();
      if (data?.filename) return filenameToTitle(data.filename);
      if (data?.title && typeof data.title === "string" && data.title.trim()) return data.title.trim();
    }
  } catch { /* proxy unavailable */ }

  return null;
}

function extractHttpLinks(text: string): string[] {
  if (!text) return [];
  return text
    .split(/(?=https?:\/\/)/gi)
    .map((s) => s.trim().replace(/[\s,;]+$/, ""))
    .filter((s) => /^https?:\/\//i.test(s));
}

function parseSeasonEpisode(title: string): { season: number | null; episode: number | null } | null {
  if (!title) return null;
  let m = title.match(/s(\d{1,4})[\s._-]*e(\d{1,4})/i);
  if (m) return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) };
  m = title.match(/\b(\d{1,2})x(\d{1,3})\b/i);
  if (m) return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) };
  m = title.match(/\bepisode[\s._-]*(\d{1,4})\b/i);
  if (m) return { season: null, episode: parseInt(m[1], 10) };
  m = title.match(/\bep[\s._-]*(\d{1,4})\b/i);
  if (m) return { season: null, episode: parseInt(m[1], 10) };
  m = title.match(/\b(?:s|season)[\s._-]*(\d{1,4})(?!\d)/i);
  if (m) return { season: parseInt(m[1], 10), episode: null };
  return null;
}

function stripShowName(title: string) {
  if (!title) return "";
  let name = title.replace(/[._]+/g, " ");
  const seMatch = name.match(/\b(s\d{1,4}[\s._-]*e\d{1,4}|\d{1,2}x\d{1,4}|episode[\s._-]*\d{1,4}|ep[\s._-]*\d{1,4}|(?:s|season)[\s._-]*\d{1,4})(?!\d)/i);
  if (seMatch && seMatch.index !== undefined) name = name.slice(0, seMatch.index);
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

function episodeKey(title: string) {
  const show = stripShowName(title);
  const se = parseSeasonEpisode(title);
  if (se) {
    const seasonStr = se.season !== null ? `s${String(se.season).padStart(2, "0")}` : "";
    const epStr = se.episode !== null ? `e${String(se.episode).padStart(2, "0")}` : "";
    return `${show}|${seasonStr}${epStr}`;
  }
  return show || title.toLowerCase().trim();
}

function splitIntoGroups<T>(arr: T[], splitCount: number, perGroup: number): T[][] {
  if (perGroup && perGroup > 0) {
    const g: T[][] = [];
    for (let i = 0; i < arr.length; i += perGroup) g.push(arr.slice(i, i + perGroup));
    return g;
  }
  if (splitCount && splitCount >= 2) {
    const g: T[][] = [];
    const size = Math.ceil(arr.length / splitCount);
    for (let i = 0; i < splitCount; i++) {
      const c = arr.slice(i * size, (i + 1) * size);
      if (c.length > 0) g.push(c);
    }
    return g;
  }
  return [arr];
}

function splitByKeywords(arr: HttpLink[], keywords: string[]): LinkGroup[] {
  const kws = keywords.map((k) => k.trim()).filter(Boolean);
  if (!kws.length) return [{ label: "Group 1", items: arr }];
  const buckets: LinkGroup[] = kws.map((k) => ({ label: k, items: [] }));
  const ungrouped: HttpLink[] = [];
  for (const item of arr) {
    const hay = `${item.title} ${item.url}`.toLowerCase();
    const idx = kws.findIndex((k) => hay.includes(k.toLowerCase()));
    if (idx >= 0) buckets[idx].items.push(item);
    else ungrouped.push(item);
  }
  buckets.push({ label: "Ungrouped", items: ungrouped });
  return buckets;
}

function urlKeyOf(u: string) {
  return plainUrlOf(u).toLowerCase().replace(/\/+$/, "");
}

// ── API (Supabase) — HTTP links ─────────────────────────────────────────────
function rowToHttpLink(r: any): HttpLink {
  return {
    id: String(r.id),
    title: r.title ?? "",
    url: r.url ?? "",
    created_date: r.created_at,
  };
}

async function dbListHttpLinks(): Promise<{ list: HttpLink[] }> {
  const { data, error } = await supabase
    .from("http_links")
    .select("id, title, url, created_at")
    .order("created_at", { ascending: false })
    .limit(10000);
  if (error) throw new Error(error.message);
  return { list: (data || []).map(rowToHttpLink) };
}

async function dbAddHttpLink(title: string, url: string): Promise<HttpLink> {
  const { data, error } = await supabase
    .from("http_links")
    .insert({ title: title.slice(0, 1000), url: url.slice(0, 4000) })
    .select("id, title, url, created_at")
    .single();
  if (error) throw new Error(error.message);
  return rowToHttpLink(data);
}

async function dbAddHttpLinksBulk(records: { title: string; url: string }[]): Promise<{ list: HttpLink[] }> {
  if (!records.length) return { list: [] };
  const payload = records.map((r) => ({
    title: String(r.title ?? "").slice(0, 1000),
    url: String(r.url ?? "").slice(0, 4000),
  }));
  const { data, error } = await supabase.from("http_links").insert(payload).select("id, title, url, created_at");
  if (error) throw new Error(error.message);
  return { list: (data || []).map(rowToHttpLink) };
}

async function dbUpdateHttpLinkUrl(id: string, url: string): Promise<void> {
  const { error } = await supabase.from("http_links").update({ url: url.slice(0, 4000) }).eq("id", Number(id));
  if (error) throw new Error(error.message);
}

async function dbUpdateHttpLinksUrlsBulk(updates: { id: string; url: string }[]): Promise<void> {
  if (!updates.length) return;
  const CHUNK_SIZE = 500;
  for (let i = 0; i < updates.length; i += CHUNK_SIZE) {
    const chunk = updates.slice(i, i + CHUNK_SIZE).map((u) => ({ id: Number(u.id), url: u.url.slice(0, 4000) }));
    const { error } = await supabase.from("http_links").upsert(chunk, { onConflict: "id" });
    if (error) throw new Error(error.message);
  }
}

async function dbDeleteHttpLink(id: string): Promise<void> {
  const { error } = await supabase.from("http_links").delete().eq("id", Number(id));
  if (error) throw new Error(error.message);
}

async function dbDeleteHttpLinksBulk(ids: string[]): Promise<void> {
  const numIds = ids.map((v) => Number(v)).filter((n) => Number.isFinite(n));
  if (!numIds.length) return;
  const { error } = await supabase.from("http_links").delete().in("id", numIds);
  if (error) throw new Error(error.message);
}

// ── Background ornaments ──────────────────────────────────────────────────────
function OceanBg() {
  return (
    <>
      <div className="orb orb-1" />
      <div className="orb orb-2" />
      <div className="orb orb-3" />
      {Array.from({ length: 24 }).map((_, i) => (
        <span key={i} className="bubble-bg" aria-hidden>{i % 3 === 0 ? "🫧" : i % 3 === 1 ? "🐚" : "🐠"}</span>
      ))}
      {Array.from({ length: 7 }).map((_, i) => (
        <span key={i} className="mermaid-bg" aria-hidden>{i % 2 === 0 ? "🧜‍♀️" : "🧜‍♂️"}</span>
      ))}
    </>
  );
}

// ── Inline SVG icons ──────────────────────────────────────────────────────────
const I = {
  Mermaid: () => (<svg viewBox="0 0 24 24" fill="white" style={{ width: '1.4rem', height: '1.4rem' }}><path d="M12 2c-1.5 1.8-2.2 3.6-2.2 5.4 0 1.6.7 2.6 2.2 4 1.5-1.4 2.2-2.4 2.2-4C14.2 5.6 13.5 3.8 12 2z"/><circle cx="12" cy="9.2" r="1.4"/><path d="M7 13c0 4 2 8 5 9 3-1 5-5 5-9-1.6 1.4-3.3 2-5 2s-3.4-.6-5-2z"/></svg>),
  Chevron: () => (<svg className="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6" /></svg>),
  Funnel: () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" /></svg>),
  Search: () => (<svg className="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></svg>),
  Eye: () => (<svg className="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></svg>),
  EyeOff: () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></svg>),
  Split: () => (<svg className="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2v-4M9 21H5a2 2 0 0 1-2-2v-4m0 0h18" /></svg>),
  Copy: () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect width="14" height="14" x="8" y="8" rx="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></svg>),
  Sort: () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M7 12h10M11 18h2" /></svg>),
  Dedupe: () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 20h20M6 20V10l6-8 6 8v10" /><path d="M10 20v-5h4v5" /></svg>),
  Exact: () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><rect x="8" y="2" width="8" height="4" rx="1" ry="1" /><line x1="9" y1="14" x2="15" y2="14" /><line x1="9" y1="10" x2="15" y2="10" /></svg>),
  Sync: ({ spin }: { spin?: boolean }) => (<svg className={spin ? "mv-spin" : ""} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M3 22v-6h6" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /></svg>),
  Trash: () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6l-1 14H6L5 6M10 11v6M14 11v6M9 6V4h6v2" /></svg>),
  TrashSlash: () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6l-1 14H6L5 6M10 11v6M14 11v6M9 6V4h6v2" /><line x1="4" y1="20" x2="20" y2="4" /></svg>),
  Fire: () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" /></svg>),
  Plus: () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5v14" /></svg>),
  ArrowUp: () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m18 15-6-6-6 6" /></svg>),
  ArrowDown: () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m6 9 6 6 6-6" /></svg>),
  X: () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6 6 18M6 6l12 12" /></svg>),
  Check: () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M20 6 9 17l-5-5" /></svg>),
  Tag: () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20.59 13.41 11 3.83A2 2 0 0 0 9.59 3.24L3 3v6.59a2 2 0 0 0 .59 1.41l9.59 9.59a2 2
