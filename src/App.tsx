import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase, supabaseConfigured } from "./supabaseClient";

// ── Types ─────────────────────────────────────────────────────────────────────
type HttpLink = { id: string; title: string; url: string; created_date?: string };
type Toast = { id: number; msg: string; kind: "ok" | "error" };
type Confirmation = { title: string; body: string; danger?: boolean; onConfirm: () => void } | null;
type LinkGroup = { label: string; items: HttpLink[] };

const PRIO_KEY = "link-vault-priority";

// ── Helpers ───────────────────────────────────────────────────────────────────
// Tagged links look like "https://...file.mkv|Some.Release.Name" (e.g. from
// link-grabber style tools). The part after the first "|" is a plain-text tag
// that travels alongside the URL. Tagged links are kept as-is (URL + tag
// together) in storage; these helpers let the rest of the app reason about
// the URL and tag separately without mutating what's stored. The tag is
// metadata only — the title is always derived from the URL itself, never
// from the tag text.
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
// Derives a clean, human-readable title from a URL's path: prefers the
// last segment (decoding %xx escapes, stripping common file extensions,
// turning -._+ into spaces, and title-casing the result), and only borrows
// context from an earlier segment when the last one alone is too thin.
// Detects path segments that are opaque ids/hashes/timestamps rather than
// human-readable title text — e.g. CDN links often look like
// /cdn/<random-codename>/<hash>.<num>/<timestamp>/<sha1>/<sha256>/My Show S01E01....mkv
// Such segments must never be folded into the parsed title: besides being
// unreadable, they're typically unique per file, which silently breaks
// show-name grouping (every episode looks like a "different show").
function isOpaqueIdSegment(s: string): boolean {
  if (!s) return false;
  if (/^\d+$/.test(s)) return true; // pure numeric: timestamp/numeric id
  if (/^[0-9a-f]{16,}$/i.test(s)) return true; // long hex hash/token, no separators
  const words = s.replace(/[._-]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (s.length >= 14 && words.length && words.every((w) => /^[0-9a-f]+$/i.test(w) || /^\d+$/.test(w))) return true;
  return false;
}
// True for short opaque slugs — the base62-ish per-file ids that URL shorteners
// and file hosts use as their public identifier, e.g. pixeldrain's `jKaWhLWC`
// or a YouTube video id. They contain no word separators and no readable
// English, so folding them into a title just produces noise like "U JKaWhLWC".
// Distinct from isOpaqueIdSegment, which only catches longer hex/numeric hashes.
function isSlugLikeSegment(s: string): boolean {
  if (!s) return false;
  if (s.length < 6 || s.length > 40) return false;
  if (/[-_.+\s]/.test(s)) return false; // has word separators → not a slug id
  const hasLower = /[a-z]/.test(s);
  const hasUpper = /[A-Z]/.test(s);
  const hasDigit = /\d/.test(s);
  // Mixed case (jKaWhLWC) or letters+digits with no lowercase-only word shape
  if (hasLower && hasUpper) return true;
  if (hasDigit && (hasLower || hasUpper) && !/^[a-z]+\d{1,4}$/i.test(s)) return true;
  return false;
}
function parseHttpLinkTitle(url: string) {
  if (!url) return "";
  const plain = plainUrlOf(url);
  try {
    const u = new URL(plain.trim());
    // Route/action segments that carry no title information: they appear on
    // download-link, share-link, and file-hosting URLs as short slugs
    // (e.g. `/u/<id>`, `/d/<id>`, `/files/file-download/<uuid>`), and folding
    // them into the title just produces noise like "U JKaWhLWC" or
    // "File Download 9028844b...".
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

    // The last path segment (typically the filename) is almost always the
    // richest source of title info. Only reach further back — and only as
    // far as the nearest non-opaque, non-generic segment — when the last
    // segment alone is too thin (an id, or just 1-2 words) to be a title.
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
    // Normalize season/episode casing, e.g. "S01e02" -> "S01E02"
    title = title.replace(/\bs(\d{1,4})e(\d{1,4})\b/i, (_m, s, e) => `S${s}E${e}`);
    return title;
  } catch {
    return "";
  }
}
// True when a URL-derived title is too thin to trust — it fell back to the
// bare hostname, is mostly an opaque id/hash, or has fewer than two real
// words. Titles like this are exactly the case where the URL's path didn't
// contain the real name, and it's worth paying for a network round-trip to
// ask the host directly (via Content-Disposition) instead.
function isUrlTitleWeak(title: string, url: string): boolean {
  if (!title) return true;
  const plain = plainUrlOf(url);
  try {
    const u = new URL(plain.trim());
    const host = u.hostname.replace(/^www\./i, "");
    if (title.toLowerCase() === host.toLowerCase()) return true;
    // If the URL's last path segment is itself an opaque id or short slug,
    // the parsed title is only as good as the sibling/generic segment it
    // borrowed from — worth going to the network for the real name even
    // when the resulting string has a few words in it.
    const segs = u.pathname.split("/").filter(Boolean);
    const lastRaw = segs[segs.length - 1] || "";
    let lastDecoded = lastRaw.replace(/\.(html?|php|aspx?|jsp|m3u8|mp4|mkv|webm|json|xml)$/i, "");
    try { lastDecoded = decodeURIComponent(lastDecoded); } catch { /* keep raw */ }
    if (lastDecoded && (isOpaqueIdSegment(lastDecoded) || isSlugLikeSegment(lastDecoded))) return true;
  } catch { /* invalid URL - let caller's own validation handle it */ }
  const words = title.replace(/[^\w\s]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return true;
  if (isOpaqueIdSegment(title.replace(/\s+/g, ""))) return true;
  return false;
}
// Pulls a filename out of a raw Content-Disposition header value, handling
// both the plain `filename="..."` form and the RFC 5987/6266 encoded
// `filename*=UTF-8''...` form that non-ASCII names use.
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
// Cleans up a raw filename the same way parseHttpLinkTitle cleans a URL
// segment: strip the extension, decode %xx escapes, turn -._+ into spaces,
// title-case, and normalize SxxExx casing.
function filenameToTitle(filename: string): string {
  let base = filename.replace(/\.(html?|php|aspx?|jsp|m3u8|mp4|mkv|webm|avi|mov|m4v|json|xml)$/i, "");
  try { base = decodeURIComponent(base); } catch { /* leave as-is if malformed escape */ }
  let title = base.replace(/[-_+.]+/g, " ").replace(/\s+/g, " ").trim();
  if (!title) return "";
  title = title.split(" ").map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ");
  title = title.replace(/\bs(\d{1,4})e(\d{1,4})\b/i, (_m, s, e) => `S${s}E${e}`);
  return title;
}
// Asks the host that's actually serving the file for its real filename, via
// the Content-Disposition header direct-download links commonly send
// (e.g. `attachment; filename="Show.S01E02.mkv"`). Tries a direct
// same-browser HEAD request first; most third-party file hosts don't send
// permissive CORS headers though, so that request is silently blocked by
// the browser rather than actually failing at the network level — in that
// case we fall back to a same-origin proxy endpoint (a Cloudflare Pages
// Function, see /functions/api/resolve-filename.ts) which makes the request
// server-side, where browser CORS rules don't apply.
async function fetchContentDispositionTitle(url: string, timeoutMs = 4000): Promise<string | null> {
  const target = plainUrlOf(url);
  const withTimeout = () => (typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(timeoutMs) : undefined);

  try {
    const res = await fetch(target, { method: "HEAD", mode: "cors", redirect: "follow", signal: withTimeout() });
    const name = parseContentDispositionFilename(res.headers.get("content-disposition"));
    if (name) return filenameToTitle(name);
  } catch { /* likely blocked by CORS, or the host rejects HEAD - try the proxy */ }

  try {
    // Give the proxy more time than the direct in-browser attempt above:
    // it does up to two round-trips server-side (HEAD, then GET), each of
    // which can take a few seconds against a slow host, so the same 4s
    // budget that's reasonable for a single direct request is too tight
    // here and can abort a request that would otherwise have succeeded.
    const proxyTimeoutMs = Math.max(timeoutMs, 9000);
    const withProxyTimeout = () =>
      typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(proxyTimeoutMs) : undefined;
    const proxied = await fetch(`/api/resolve-filename?url=${encodeURIComponent(target)}`, { signal: withProxyTimeout() });
    if (proxied.ok) {
      const data = await proxied.json();
      // Prefer a real Content-Disposition filename (the raw stored name on
      // the host) over an HTML <title> (which is a page label and may carry
      // site branding); fall back to the page title when there's no filename.
      if (data?.filename) return filenameToTitle(data.filename);
      if (data?.title && typeof data.title === "string" && data.title.trim()) return data.title.trim();
    }
  } catch { /* proxy unavailable (e.g. local dev without wrangler) - give up quietly */ }

  return null;
}
// Splits a blob of text into individual http(s) links, even when links are
// pasted back-to-back with no whitespace between them
// (e.g. "https://buffer.comhttps://outlook.com").
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
  // Episode-only formats with no season marker, e.g. "Episode 12", "Ep.12", "Ep 12"
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
// Splits links into one group per space-separated keyword (a link goes into
// the group for the first keyword it matches, checked in the order the
// keywords were given), plus a final "Ungrouped" group for links that don't
// match any of the keywords.
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

// Was previously one `update().eq("id", ...)` round-trip per link — fine for
// a handful of links, but for batch actions (Untag Visible, Untag matches,
// Restore Tags) over dozens/hundreds of links that meant dozens/hundreds of
// sequential network requests with the whole UI disabled (`syncing`) the
// entire time, which is what read as the app "freezing". Postgres/PostgREST
// supports updating many rows in one round-trip via upsert: since only `id`
// and `url` are included in each row, the merge only touches those two
// columns and leaves title/created_at untouched. Chunked defensively so a
// very large batch doesn't hit request-size limits in a single call.
//
// NOTE: "Untag matches" now applies locally (like Untag Visible / Restore
// Tags) instead of calling this, so this helper is currently unused there —
// kept in case a future bulk-write action needs it.
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
  Tag: () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20.59 13.41 11 3.83A2 2 0 0 0 9.59 3.24L3 3v6.59a2 2 0 0 0 .59 1.41l9.59 9.59a2 2 0 0 0 2.82 0l6.59-6.59a2 2 0 0 0 0-2.82z" /><circle cx="7.5" cy="7.5" r="1.5" /></svg>),
  TagOff: () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20.59 13.41 11 3.83A2 2 0 0 0 9.59 3.24L3 3v6.59a2 2 0 0 0 .59 1.41l9.59 9.59a2 2 0 0 0 2.82 0l6.59-6.59a2 2 0 0 0 0-2.82z" /><circle cx="7.5" cy="7.5" r="1.5" /><line x1="2" y1="2" x2="22" y2="22" /></svg>),
};

// ── HttpLinkRow ──
type HttpLinkRowProps = {
  l: HttpLink;
  selected: boolean;
  onToggle: (id: string) => void;
  onCopy: (text: string, label: string) => void;
  onDelete: (id: string) => void;
  onUntag: (id: string) => void;
  onRetag: (id: string) => void;
};
function HttpLinkRow({ l, selected, onToggle, onCopy, onDelete, onUntag, onRetag }: HttpLinkRowProps) {
  const se = parseSeasonEpisode(l.title);
  const date = l.created_date ? new Date(l.created_date).toLocaleString() : "";
  const tag = tagOf(l.url);
  return (
    <li className={`link-row${selected ? " selected" : ""}`} onClick={() => onToggle(l.id)}>
      <div className="link-row-inner">
        <div className="link-meta">
          <div className="link-title-wrap">
            <span className="link-title">{l.title || "(untitled)"}</span>
            {se && <span className="ep-badge">{se.season !== null ? "S" + String(se.season).padStart(2, "0") : ""}{se.episode !== null ? "E" + String(se.episode).padStart(2, "0") : ""}</span>}
            {tag && <span className="ep-badge">TAGGED</span>}
          </div>
          <p className="link-magnet">{l.url}</p>
          <p className="link-date">{date}</p>
        </div>
        <div className="link-actions" onClick={(e) => e.stopPropagation()}>
          <button className="icon-btn" onClick={() => onCopy(l.url, "Link copied")} aria-label="Copy link"><I.Copy /></button>
          {tag && <button className="icon-btn" onClick={() => onUntag(l.id)} aria-label="Untag link"><I.TagOff /></button>}
          <button className="icon-btn" onClick={() => onRetag(l.id)} aria-label={tag ? "Retag link" : "Add tag"}><I.Tag /></button>
          <button className="icon-btn del" onClick={() => onDelete(l.id)} aria-label="Delete link"><I.Trash /></button>
        </div>
      </div>
    </li>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  // ── State ────────────────────────────────────────────────────────────────
  const [allLinks, setAllLinks] = useState<HttpLink[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [syncing, setSyncing] = useState(false);
  const [connected, setConnected] = useState(false);

  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastIdRef = useRef(0);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);

  const [priorityWords, setPriorityWords] = useState<string[]>(() => {
    try {
      const r = localStorage.getItem(PRIO_KEY);
      return r ? JSON.parse(r) : ["repack", "proper", "2160p", "1080p"];
    } catch { return ["repack", "proper", "2160p", "1080p"]; }
  });
  const [newPrio, setNewPrio] = useState("");
  const [dedupeMode, setDedupeMode] = useState<"priority" | "first" | "last">("priority");
  const [dedupeIgnore, setDedupeIgnore] = useState("");
  const [hidePhrase, setHidePhrase] = useState("");
  const [phraseHiddenIds, setPhraseHiddenIds] = useState<Set<string>>(new Set());

  // Remembers the most recently removed tag for each link id (in-memory only,
  // not persisted to the DB or across reloads) so a batch "Restore Tags"
  // action can put tags back after a batch untag. Populated by every place
  // that strips a tag: single-row untag, single-row retag-to-blank, the
  // keyword-based "Untag matches" batch action, and "Untag Visible" below.
  const [lastTagById, setLastTagById] = useState<Map<string, string>>(new Map());

  // filters
  const [fShow, setFShow] = useState("");
  const [fTerm, setFTerm] = useState("");
  const [fOr, setFOr] = useState("");
  const [fOnly, setFOnly] = useState("");
  const [fExcept, setFExcept] = useState("");
  const [fHideCount, setFHideCount] = useState("");
  const [fHidePos, setFHidePos] = useState<"top" | "bottom">("top");
  const [fSplit, setFSplit] = useState("");
  const [fPerGroup, setFPerGroup] = useState("");
  const [fGroupKeywords, setFGroupKeywords] = useState("");

  // add form
  const [addTitle, setAddTitle] = useState("");
  const [addUrl, setAddUrl] = useState("");
  const [untagFilter, setUntagFilter] = useState("");
  const [batchTagFilter, setBatchTagFilter] = useState("");
  const [batchTagValue, setBatchTagValue] = useState("");

  // ── Toast / confirm helpers ──────────────────────────────────────────────
  const pushToast = useCallback((msg: string, kind: "ok" | "error" = "ok") => {
    const id = ++toastIdRef.current;
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  }, []);

  const askConfirm = useCallback((c: NonNullable<Confirmation>) => setConfirmation(c), []);

  // ── Persist priority ─────────────────────────────────────────────────────
  useEffect(() => {
    localStorage.setItem(PRIO_KEY, JSON.stringify(priorityWords));
  }, [priorityWords]);

  // ── Filters ──────────────────────────────────────────────────────────────
  const filters = useMemo(() => ({
    show: fShow.trim().toLowerCase(),
    term: fTerm.trim().toLowerCase(),
    or: fOr.trim().toLowerCase(),
    only: fOnly.trim().toLowerCase(),
    except: fExcept.trim().toLowerCase(),
    hideCount: parseInt(fHideCount || "0", 10),
    hidePos: fHidePos,
    splitCount: parseInt(fSplit || "0", 10),
    perGroup: parseInt(fPerGroup || "0", 10),
    groupKeywords: fGroupKeywords.trim(),
  }), [fShow, fTerm, fOr, fOnly, fExcept, fHideCount, fHidePos, fSplit, fPerGroup, fGroupKeywords]);

  const isFilterActive = !!(filters.show || filters.term || filters.or || filters.only || filters.except || (filters.hideCount > 0));

  const filteredLinks = useMemo(() => {
    const terms = filters.term ? filters.term.split(/\s+/).filter(Boolean) : [];
    const orTerms = filters.or ? filters.or.split(/\s+/).filter(Boolean) : [];
    const onlyPhrases = filters.only ? filters.only.split(",").map((p) => p.trim()).filter(Boolean) : [];
    const exceptPhrases = filters.except ? filters.except.split(",").map((p) => p.trim()).filter(Boolean) : [];

    let result = allLinks.filter((l) => {
      if (hiddenIds.has(l.id)) return false;
      if (phraseHiddenIds.has(l.id)) return false;
      const titleLower = (l.title || "").toLowerCase();
      const showName = stripShowName(l.title);
      const searchText = `${l.title} ${l.url}`.toLowerCase();
      if (onlyPhrases.length && !onlyPhrases.some((p) => titleLower.includes(p))) return false;
      if (exceptPhrases.length && exceptPhrases.some((p) => titleLower.includes(p))) return false;
      if (filters.show && !showName.includes(filters.show)) return false;
      if (terms.length && !terms.every((t) => searchText.includes(t))) return false;
      if (orTerms.length && !orTerms.some((t) => searchText.includes(t))) return false;
      return true;
    });

    if (filters.hideCount > 0) {
      result = filters.hidePos === "top"
        ? result.slice(filters.hideCount)
        : result.slice(0, Math.max(0, result.length - filters.hideCount));
    }
    return result;
  }, [allLinks, hiddenIds, phraseHiddenIds, filters]);

  const groups = useMemo<LinkGroup[] | null>(() => {
    const kws = filters.groupKeywords ? filters.groupKeywords.split(/\s+/).filter(Boolean) : [];
    if (kws.length) return splitByKeywords(filteredLinks, kws);

    const useSplit = filters.splitCount >= 2 || filters.perGroup >= 1;
    if (!useSplit) return null;
    const plain = splitIntoGroups(filteredLinks, filters.splitCount >= 2 ? filters.splitCount : 0, filters.perGroup >= 1 ? filters.perGroup : 0);
    return plain.map((items, i) => ({ label: `Group ${i + 1}`, items }));
  }, [filteredLinks, filters.splitCount, filters.perGroup, filters.groupKeywords]);

  // Visible (filtered) links that currently carry a tag — the scope for "Untag Visible".
  const taggedVisibleCount = useMemo(() => filteredLinks.filter((l) => isTaggedLink(l.url)).length, [filteredLinks]);
  // Visible links that are currently untagged but have a remembered previous tag — the scope for "Restore Tags".
  const restorableVisibleCount = useMemo(
    () => filteredLinks.filter((l) => !isTaggedLink(l.url) && lastTagById.has(l.id)).length,
    [filteredLinks, lastTagById]
  );

  // ── Fetch ────────────────────────────────────────────────────────────────
  const fetchLinks = useCallback(async () => {
    setSyncing(true);
    try {
      const data = await dbListHttpLinks();
      setAllLinks(data.list || []);
      setConnected(true);
      setHiddenIds(new Set());
      pushToast("Vault synced", "ok");
    } catch (e: any) {
      setConnected(false);
      pushToast("Sync failed: " + e.message, "error");
    } finally {
      setSyncing(false);
    }
  }, [pushToast]);

  useEffect(() => { fetchLinks(); }, [fetchLinks]);

  // ── Bookmarklet ingest (window.postMessage) ─────────────────────────────
  // A bookmarklet running on another page can postMessage links in here, e.g.:
  //   window.opener.postMessage({ source: "magnet-vault-bookmarklet", text: "..." }, "*")
  // `text` may contain one or more http(s) links, plain or tagged
  // (e.g. "https://...mkv|Release.Name"), mixed together, one per line or blob.
  //
  // FIX (duplicate links from postMessage): the old version checked
  // candidates against `allLinks` React *state*, but state only reflects
  // reality after `fetchLinks()` resolves at the end of the async handler.
  // If the bookmarklet fires the message twice in quick succession (double
  // postMessage, a page that sends the payload on multiple events, etc.),
  // both calls read the same stale `allLinks` snapshot, both conclude the
  // link isn't in the vault yet, and both insert it — producing duplicates.
  //
  // Fix has two parts:
  //   1. `knownUrlKeysRef` mirrors known URLs but updates synchronously
  //      (via a plain ref, not state), so we can also reserve a URL the
  //      instant we decide to add it — before the network round-trip even
  //      starts — closing the window where a second call could see the
  //      same "not yet known" URL.
  //   2. `bookmarkletQueueRef` chains every incoming message onto a single
  //      promise so overlapping calls run strictly one after another
  //      instead of interleaving.
  const knownUrlKeysRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    knownUrlKeysRef.current = new Set(allLinks.map((l) => urlKeyOf(l.url)));
  }, [allLinks]);

  const bookmarkletQueueRef = useRef<Promise<void>>(Promise.resolve());

  const ingestBookmarkletText = useCallback(async (text: string) => {
    const candidates = extractHttpLinks(text).filter(isValidHttpLink);
    if (!candidates.length) {
      pushToast("Bookmarklet: no valid links found", "error");
      return;
    }
    const seenInBatch = new Set<string>();
    const toAdd = candidates.filter((s) => {
      const k = urlKeyOf(s);
      if (knownUrlKeysRef.current.has(k) || seenInBatch.has(k)) return false;
      seenInBatch.add(k);
      return true;
    });
    if (!toAdd.length) {
      pushToast("Bookmarklet: all links already in vault");
      return;
    }
    // Reserve these URLs immediately — before the async title lookup / DB
    // insert even starts — so a message that arrives while this one is
    // still in flight sees them as already-known and skips them, instead
    // of racing to insert the same link twice.
    toAdd.forEach((s) => knownUrlKeysRef.current.add(urlKeyOf(s)));
    try {
      const payload = await Promise.all(
        toAdd.map(async (s) => {
          let title = parseHttpLinkTitle(s) || s.slice(0, 160);
          if (isUrlTitleWeak(title, s)) {
            const discovered = await fetchContentDispositionTitle(s);
            if (discovered) title = discovered;
          }
          return { title, url: s };
        })
      );
      await dbAddHttpLinksBulk(payload);
      await fetchLinks();
      pushToast(`Bookmarklet: added ${toAdd.length} link(s)`);
    } catch (e: any) {
      // Insert failed — release the reservation so a retry (or the next
      // message) can attempt these URLs again instead of silently dropping them.
      toAdd.forEach((s) => knownUrlKeysRef.current.delete(urlKeyOf(s)));
      pushToast("Bookmarklet add failed: " + e.message, "error");
    }
  }, [fetchLinks, pushToast]);

  // Public entry point: chains onto the shared queue so concurrent/rapid
  // postMessage deliveries are processed strictly in order, never in parallel.
  const handleBookmarkletText = useCallback((text: string) => {
    bookmarkletQueueRef.current = bookmarkletQueueRef.current
      .catch(() => { /* previous ingest's error already reported via toast */ })
      .then(() => ingestBookmarkletText(text));
  }, [ingestBookmarkletText]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      let data: any = event.data;
      if (typeof data === "string") {
        try { data = JSON.parse(data); } catch { data = { text: data }; }
      }
      if (!data || typeof data !== "object") return;
      if (data.source !== "magnet-vault-bookmarklet") return;
      const text = String(data.text ?? data.links ?? "");
      if (!text.trim()) return;
      handleBookmarkletText(text);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [handleBookmarkletText]);

  // ── Actions ──────────────────────────────────────────────────────────────
  function toggleSelect(id: string) {
    setSelectedIds((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  async function copyText(text: string, label = "Copied") {
    try {
      await navigator.clipboard.writeText(text);
      pushToast(label);
    } catch {
      pushToast("Clipboard copy failed", "error");
    }
  }

  function copyGroup(idx: number) {
    if (!groups || !groups[idx] || !groups[idx].items.length) return pushToast("Nothing to copy", "error");
    copyText(groups[idx].items.map((l) => l.url).join("\n"), `Copied ${groups[idx].label} — ${groups[idx].items.length} link(s)`);
  }

  function handleCopyAll() {
    if (selectedIds.size > 0) {
      const sel = allLinks.filter((l) => selectedIds.has(l.id));
      if (!sel.length) return;
      copyText(sel.map((l) => l.url).join("\n"), `Copied ${sel.length} selected link(s)!`);
      setSelectedIds(new Set());
      return;
    }
    if (!filteredLinks.length) return pushToast("Nothing to copy", "error");
    copyText(filteredLinks.map((l) => l.url).join("\n"), `Copied ${filteredLinks.length} link(s)`);
  }

  function copyScope(): HttpLink[] {
    if (selectedIds.size > 0) return allLinks.filter((l) => selectedIds.has(l.id));
    return filteredLinks;
  }

  // Copies the plain URL only — the "|Tag" suffix (if any) is always stripped
  // via plainUrlOf, regardless of whether the source link is tagged.
  function handleCopyPlain() {
    const sel = copyScope();
    if (!sel.length) return pushToast("Nothing to copy", "error");
    copyText(sel.map((l) => plainUrlOf(l.url)).join("\n"), `Copied ${sel.length} link(s) (plain, no tag)`);
    if (selectedIds.size > 0) setSelectedIds(new Set());
  }

  function handleCopyTag() {
    const sel = copyScope();
    if (!sel.length) return pushToast("Nothing to copy", "error");
    copyText(sel.map((l) => buildTagged(plainUrlOf(l.url), tagOf(l.url) || l.title)).join("\n"), `Copied ${sel.length} link(s) (tagged)`);
    if (selectedIds.size > 0) setSelectedIds(new Set());
  }

  async function handleUntag(id: string) {
    const item = allLinks.find((l) => l.id === id);
    if (!item) return;
    const { url: plain, tag } = splitTag(item.url);
    if (plain === item.url) return; // already untagged
    setSyncing(true);
    try {
      await dbUpdateHttpLinkUrl(id, plain);
      setAllLinks((prev) => prev.map((l) => (l.id === id ? { ...l, url: plain } : l)));
      if (tag) setLastTagById((m) => { const n = new Map(m); n.set(id, tag); return n; });
      pushToast("Untagged");
    } catch (e: any) { pushToast("Untag failed: " + e.message, "error"); }
    finally { setSyncing(false); }
  }

  async function handleRetag(id: string) {
    const item = allLinks.find((l) => l.id === id);
    if (!item) return;
    const { url: plain, tag } = splitTag(item.url);
    const next = window.prompt("Tag for this link (leave blank to remove tag):", tag);
    if (next === null) return; // cancelled
    const newUrl = buildTagged(plain, next);
    if (newUrl === item.url) return;
    setSyncing(true);
    try {
      await dbUpdateHttpLinkUrl(id, newUrl);
      setAllLinks((prev) => prev.map((l) => (l.id === id ? { ...l, url: newUrl } : l)));
      if (next.trim()) {
        // A real tag now exists on this link; it's no longer "restorable".
        setLastTagById((m) => { if (!m.has(id)) return m; const n = new Map(m); n.delete(id); return n; });
      } else if (tag) {
        setLastTagById((m) => { const n = new Map(m); n.set(id, tag); return n; });
      }
      pushToast(next.trim() ? "Tag updated" : "Untagged");
    } catch (e: any) { pushToast("Retag failed: " + e.message, "error"); }
    finally { setSyncing(false); }
  }

  // Untags every tagged link (regardless of current filters) whose title or
  // URL contains any of the given comma-separated keywords — LOCAL STATE
  // ONLY, no Supabase call, mirroring handleUntagVisible/handleRestorePreviousTags
  // below. Each removed tag is remembered in lastTagById so "Restore Tags"
  // can put it back later; hitting Sync reloads the real, still-tagged data
  // from the DB.
  function handleUntagFilter() {
    const phrases = untagFilter.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);
    if (!phrases.length) return pushToast("Enter a keyword first", "error");
    const matches = allLinks.filter(
      (l) => isTaggedLink(l.url) && phrases.some((p) => `${l.title} ${l.url}`.toLowerCase().includes(p))
    );
    if (!matches.length) return pushToast("No tagged links match that keyword", "error");
    const tags = new Map<string, string>();
    matches.forEach((l) => { const t = tagOf(l.url); if (t) tags.set(l.id, t); });
    setAllLinks((prev) => prev.map((l) => (tags.has(l.id) ? { ...l, url: plainUrlOf(l.url) } : l)));
    setLastTagById((m) => { const n = new Map(m); tags.forEach((t, id) => n.set(id, t)); return n; });
    pushToast(`Untagged ${matches.length} link(s) (local only — Sync will restore them)`);
  }

  // Tags every link (regardless of current tag/filter state) whose title or
  // URL contains any of the given comma-separated keywords with the given
  // tag text, overwriting any existing tag on those links. Unlike
  // "Untag matches" above, this WRITES TO THE DATABASE (via the bulk-upsert
  // helper) since the whole point is to leave a durable tag in place, not a
  // throwaway local view.
  async function handleBatchTag() {
    const phrases = batchTagFilter.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);
    const tag = batchTagValue.trim();
    if (!phrases.length) return pushToast("Enter a keyword first", "error");
    if (!tag) return pushToast("Enter a tag first", "error");
    const matches = allLinks.filter((l) => phrases.some((p) => `${l.title} ${l.url}`.toLowerCase().includes(p)));
    if (!matches.length) return pushToast("No links match that keyword", "error");
    const updates = matches
      .map((l) => ({ id: l.id, url: buildTagged(plainUrlOf(l.url), tag) }))
      .filter((u, i) => u.url !== matches[i].url);
    if (!updates.length) return pushToast(`All matching link(s) already tagged "${tag}"`);
    setSyncing(true);
    try {
      await dbUpdateHttpLinksUrlsBulk(updates);
      const urlById = new Map(updates.map((u) => [u.id, u.url]));
      setAllLinks((prev) => prev.map((l) => (urlById.has(l.id) ? { ...l, url: urlById.get(l.id)! } : l)));
      pushToast(`Tagged ${updates.length} link(s) with "${tag}"`);
    } catch (e: any) {
      pushToast("Batch tag failed: " + e.message, "error");
    } finally {
      setSyncing(false);
    }
  }

  // Untags every currently-visible (filtered) link that has a tag —
  // LOCAL STATE ONLY, no Supabase call. Deliberately doesn't touch the DB:
  // it's meant for quickly clearing tags off-screen to eyeball/copy/dedupe,
  // not for a permanent edit. Same "sync to restore" convention used
  // elsewhere in this app (see the duplicate-hiding actions below) — hit
  // Sync and the real, still-tagged data comes back from the DB. The tag
  // each link had is remembered in lastTagById so "Restore Tags" can put it
  // back later (also locally), even after further filtering/navigation.
  function handleUntagVisible() {
    const matches = filteredLinks.filter((l) => isTaggedLink(l.url));
    if (!matches.length) return pushToast("No tagged links visible", "error");
    const tags = new Map<string, string>();
    matches.forEach((l) => { const t = tagOf(l.url); if (t) tags.set(l.id, t); });
    setAllLinks((prev) => prev.map((l) => (tags.has(l.id) ? { ...l, url: plainUrlOf(l.url) } : l)));
    setLastTagById((m) => { const n = new Map(m); tags.forEach((t, id) => n.set(id, t)); return n; });
    pushToast(`Untagged ${matches.length} visible link(s) (local only — Sync will restore them)`);
  }

  // Re-applies the remembered previous tag to every currently-visible
  // (filtered) link that is untagged and has an entry in lastTagById —
  // i.e. undoes a prior local untag for the links still on screen.
  // LOCAL STATE ONLY, no Supabase call — mirrors handleUntagVisible above.
  function handleRestorePreviousTags() {
    const candidates = filteredLinks.filter((l) => !isTaggedLink(l.url) && lastTagById.has(l.id));
    if (!candidates.length) return pushToast("No previous tags to restore for visible links", "error");
    const ids = new Set(candidates.map((l) => l.id));
    setAllLinks((prev) => prev.map((l) => {
      if (!ids.has(l.id)) return l;
      const t = lastTagById.get(l.id);
      return t ? { ...l, url: buildTagged(plainUrlOf(l.url), t) } : l;
    }));
    setLastTagById((m) => { const n = new Map(m); ids.forEach((id) => n.delete(id)); return n; });
    pushToast(`Restored tag on ${candidates.length} link(s) (local only)`);
  }

  function handleSortAlpha() {
    setAllLinks((prev) => [...prev].sort((a, b) => (a.title || a.url).localeCompare(b.title || b.url)));
    pushToast("Sorted alphabetically");
  }

  function handleSortEpisode() {
    setAllLinks((prev) => [...prev].sort((a, b) => {
      const sa = parseSeasonEpisode(a.title), sb = parseSeasonEpisode(b.title);
      if (!sa && !sb) return a.title.localeCompare(b.title);
      if (!sa) return 1; if (!sb) return -1;
      const sc = stripShowName(a.title).localeCompare(stripShowName(b.title));
      if (sc !== 0) return sc;
      const seasonA = sa.season ?? 0;
      const seasonB = sb.season ?? 0;
      if (seasonA !== seasonB) return seasonA - seasonB;
      const epA = sa.episode !== null ? sa.episode : -1;
      const epB = sb.episode !== null ? sb.episode : -1;
      return epA - epB;
    }));
    pushToast("Sorted by season + episode");
  }

  function handleDedupe() {
    const ignorePhrase = dedupeIgnore.trim().toLowerCase();
    const score = (item: HttpLink) => {
      const hay = `${item.title} ${item.url}`.toLowerCase();
      if (ignorePhrase && hay.includes(ignorePhrase)) return -1;
      for (let i = 0; i < priorityWords.length; i++)
        if (hay.includes(priorityWords[i])) return priorityWords.length - i;
      return 0;
    };
    const scope = isFilterActive ? filteredLinks : allLinks.filter((l) => !hiddenIds.has(l.id) && !phraseHiddenIds.has(l.id));
    const groupsMap = new Map<string, HttpLink[]>();
    for (const item of scope) {
      const key = episodeKey(item.title);
      if (!groupsMap.has(key)) groupsMap.set(key, []);
      groupsMap.get(key)!.push(item);
    }
    const hide: string[] = [];
    for (const arr of groupsMap.values()) {
      if (arr.length < 2) continue;
      let keeper = arr[0];
      if (dedupeMode === "last") {
        keeper = arr[arr.length - 1];
      } else if (dedupeMode === "first") {
        keeper = arr[0];
      } else {
        for (let i = 1; i < arr.length; i++) {
          const s = score(arr[i]), ks = score(keeper);
          if (s > ks) keeper = arr[i];
        }
      }
      for (const item of arr) if (item.id !== keeper.id) hide.push(item.id);
    }
    if (!hide.length) return pushToast("No duplicates found");
    setHiddenIds((h) => { const n = new Set(h); hide.forEach((i) => n.add(i)); return n; });
    pushToast(`Hid ${hide.length} duplicate(s) (sync to restore)`);
  }

  function handleExactDedupe() {
    const scope = isFilterActive ? filteredLinks : allLinks.filter((l) => !hiddenIds.has(l.id) && !phraseHiddenIds.has(l.id));
    const seen = new Set<string>();
    const hide: string[] = [];
    for (const item of scope) {
      const key = urlKeyOf(item.url);
      if (seen.has(key)) hide.push(item.id);
      else seen.add(key);
    }
    if (!hide.length) return pushToast("No exact duplicates found");
    setHiddenIds((h) => { const n = new Set(h); hide.forEach((i) => n.add(i)); return n; });
    pushToast(`Hid ${hide.length} exact duplicate(s) (sync to restore)`);
  }

  async function handleDelete(id: string) {
    setSyncing(true);
    try {
      await dbDeleteHttpLink(id);
      setAllLinks((prev) => prev.filter((l) => l.id !== id));
      setSelectedIds((s) => { const n = new Set(s); n.delete(id); return n; });
      pushToast("Link deleted");
    } catch (e: any) { pushToast("Delete failed: " + e.message, "error"); }
    finally { setSyncing(false); }
  }

  function handlePurgeFiltered() {
    if (!filteredLinks.length) return pushToast("No filtered items to drop", "error");
    askConfirm({
      title: "Purge filtered links?",
      body: `This will permanently delete the ${filteredLinks.length} visible link(s). This cannot be undone.`,
      danger: true,
      onConfirm: async () => {
        setSyncing(true);
        try {
          const ids = filteredLinks.map((l) => l.id);
          await dbDeleteHttpLinksBulk(ids);
          setAllLinks((prev) => prev.filter((l) => !ids.includes(l.id)));
          setSelectedIds(new Set());
          pushToast(`Purged ${ids.length} filtered items`);
        } catch (e: any) { pushToast("Purge failed: " + e.message, "error"); }
        finally { setSyncing(false); }
      },
    });
  }

  function handlePurge() {
    if (!allLinks.length) return pushToast("Vault already empty", "error");
    askConfirm({
      title: "Purge entire vault?",
      body: `This will permanently delete ALL ${allLinks.length} link(s). This cannot be undone.`,
      danger: true,
      onConfirm: async () => {
        setSyncing(true);
        try {
          const ids = allLinks.map((l) => l.id);
          await dbDeleteHttpLinksBulk(ids);
          setAllLinks([]);
          setSelectedIds(new Set());
          pushToast("Vault completely purged");
        } catch (e: any) { pushToast("Purge failed: " + e.message, "error"); }
        finally { setSyncing(false); }
      },
    });
  }

  async function handleAdd() {
    if (!isValidHttpLink(addUrl)) return pushToast("Invalid http(s) link", "error");
    const url = addUrl.trim();
    const userTitle = addTitle.trim();
    let t = userTitle || parseHttpLinkTitle(url) || "(untitled)";
    setSyncing(true);
    try {
      if (!userTitle && isUrlTitleWeak(t, url)) {
        const discovered = await fetchContentDispositionTitle(url);
        if (discovered) t = discovered;
      }
      const created = await dbAddHttpLink(t, url);
      setAllLinks((prev) => [created, ...prev]);
      setAddTitle(""); setAddUrl("");
      pushToast("Link added!");
    } catch (e: any) { pushToast("Add failed: " + e.message, "error"); }
    finally { setSyncing(false); }
  }

  async function handlePasteAdd() {
    const candidates = extractHttpLinks(addUrl).filter(isValidHttpLink);
    if (!candidates.length) return pushToast("No valid http(s) links found", "error");
    const existingKeys = new Set(allLinks.map((l) => urlKeyOf(l.url)));
    const seenInBatch = new Set<string>();
    const toAdd = candidates.filter((s) => {
      const k = urlKeyOf(s);
      if (existingKeys.has(k) || seenInBatch.has(k)) return false;
      seenInBatch.add(k);
      return true;
    });
    const skipped = candidates.length - toAdd.length;
    if (!toAdd.length) return pushToast(`All ${skipped} link(s) already in vault`);
    setSyncing(true);
    try {
      const payload = await Promise.all(
        toAdd.map(async (s) => {
          let title = parseHttpLinkTitle(s) || s.slice(0, 160);
          if (isUrlTitleWeak(title, s)) {
            const discovered = await fetchContentDispositionTitle(s);
            if (discovered) title = discovered;
          }
          return { title, url: s };
        })
      );
      await dbAddHttpLinksBulk(payload);
      await fetchLinks();
      setAddUrl("");
      pushToast(`Added ${toAdd.length} link(s)${skipped ? `, skipped ${skipped} duplicate(s)` : ""}`);
    } catch (e: any) { pushToast("Paste failed: " + e.message, "error"); }
    finally { setSyncing(false); }
  }

  // ── Priority ─────────────────────────────────────────────────────────────
  function movePriority(idx: number, dir: -1 | 1) {
    if (idx + dir < 0 || idx + dir >= priorityWords.length) return;
    setPriorityWords((p) => {
      const next = [...p];
      [next[idx], next[idx + dir]] = [next[idx + dir], next[idx]];
      return next;
    });
  }
  function removePriority(idx: number) { setPriorityWords((p) => p.filter((_, i) => i !== idx)); }
  function handleHidePhrase() {
    const phrase = hidePhrase.trim().toLowerCase();
    if (!phrase) return pushToast("Enter a phrase first", "error");
    const matches = allLinks.filter((l) => `${l.title} ${l.url}`.toLowerCase().includes(phrase));
    if (!matches.length) return pushToast("No links match that phrase", "error");
    setPhraseHiddenIds((h) => { const n = new Set(h); matches.forEach((l) => n.add(l.id)); return n; });
    pushToast(`Hid ${matches.length} matching link(s)`);
  }
  function handleHideAboveBelow(direction: "above" | "below") {
    const phrase = hidePhrase.trim().toLowerCase();
    if (!phrase) return pushToast("Enter a phrase first", "error");
    const scope = filteredLinks.length ? filteredLinks : allLinks;
    const idx = scope.findIndex((l) => `${l.title} ${l.url}`.toLowerCase().includes(phrase));
    if (idx === -1) return pushToast("No links match that phrase", "error");
    const slice = direction === "above" ? scope.slice(0, idx + 1) : scope.slice(idx);
    setPhraseHiddenIds((h) => { const n = new Set(h); slice.forEach((l) => n.add(l.id)); return n; });
    pushToast(`Hid ${slice.length} link(s) (${direction === "above" ? "that + above" : "that + below"})`);
  }
  function handleUnhideAll() {
    if (!phraseHiddenIds.size) return pushToast("Nothing hidden", "error");
    setPhraseHiddenIds(new Set());
    pushToast("Unhid all phrase-matched links");
  }
  function addPriorityWord() {
    const w = newPrio.trim().toLowerCase();
    if (w && !priorityWords.includes(w)) {
      setPriorityWords((p) => [...p, w]);
      setNewPrio("");
    }
  }

  // ── Render helpers ───────────────────────────────────────────────────────
  function autoFillTitle(url: string) {
    setAddUrl(url);
    if (!addTitle.trim()) {
      const p = parseHttpLinkTitle(url);
      if (p) setAddTitle(p);
    }
  }

  const statusLabel = syncing ? "Syncing…" : connected ? "Vault Synced" : "Offline / Errors";
  const copyAllLabel = selectedIds.size > 0 ? `Copy Selected (${selectedIds.size})` : "Copy All";
  const copyAllPrimary = selectedIds.size > 0;
  const dedupeLabel = isFilterActive ? "Dedupe (filtered)" : "Dedupe";
  const exactLabel = isFilterActive ? "Exact (filtered)" : "Exact Dedupe";
  const untagVisibleLabel = taggedVisibleCount > 0 ? `Untag Visible (${taggedVisibleCount})` : "Untag Visible";
  const restoreTagsLabel = restorableVisibleCount > 0 ? `Restore Tags (${restorableVisibleCount})` : "Restore Tags";

  return (
    <>
      <OceanBg />
      <div className="mv-app">
        {/* Header */}
        <header className="mv-header">
          <div className="header-icon"><I.Mermaid /></div>
          <div>
            <h1 className="mv-title">✦ Link Vault ✦</h1>
            <p className="mv-subtitle">Supabase · Link Manager</p>
          </div>
        </header>

        {!supabaseConfigured && (
          <div className="mv-card" style={{ padding: "0.85rem 1rem", borderColor: "rgba(232,85,63,0.4)", color: "var(--mv-destructive)", fontSize: "0.78rem", lineHeight: 1.6 }}>
            ⚠ Supabase isn't configured. Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> in
            your host's environment variables (e.g. Cloudflare Pages → Settings → Environment variables) and redeploy,
            or in a local <code>.env</code> file for dev. The vault can't load or save links until this is set.
          </div>
        )}

        {/* Filters */}
        <section className="filter-section mv-card" aria-label="Filters" style={{ padding: "0.9rem 1rem", gap: "0.55rem" }}>
          <div className="mv-card-title" style={{ marginBottom: "0.25rem" }}>
            <I.Funnel /> Filters
          </div>
          <div className="filter-row">
            <div className="input-wrap"><I.Search /><input type="text" value={fShow} onChange={(e) => setFShow(e.target.value)} placeholder="show name (e.g. the wire)" /></div>
            <div className="input-wrap"><I.Search /><input type="text" value={fTerm} onChange={(e) => setFTerm(e.target.value)} placeholder="all keywords (e.g. S03 1080p)" /></div>
          </div>
          <div className="filter-row">
            <div className="input-wrap"><I.Search /><input type="text" value={fOr} onChange={(e) => setFOr(e.target.value)} placeholder="exact keywords — match ANY (e.g. 2160p REPACK)" /></div>
            <div className="input-wrap"><I.Search /><input type="text" value={fOnly} onChange={(e) => setFOnly(e.target.value)} placeholder="only exact phrase (e.g. 1080p, 2160p)" /></div>
          </div>
          <div className="filter-row">
            <div className="input-wrap"><I.Search /><input type="text" value={fExcept} onChange={(e) => setFExcept(e.target.value)} placeholder="except exact phrase (e.g. cam, telesync)" /></div>
          </div>
          <div className="filter-row">
            <div className="input-wrap" style={{ flex: 2 }}><I.Eye /><input type="number" value={fHideCount} onChange={(e) => setFHideCount(e.target.value)} placeholder="Number of links to hide..." min={0} /></div>
            <div className="input-wrap" style={{ flex: 1 }}>
              <select value={fHidePos} onChange={(e) => setFHidePos(e.target.value as any)}>
                <option value="top">From Top</option>
                <option value="bottom">From Bottom (Last)</option>
              </select>
            </div>
          </div>
          <div className="filter-row">
            <div className="input-wrap" style={{ flex: 2 }}><I.Split /><input type="number" value={fSplit} onChange={(e) => setFSplit(e.target.value)} placeholder="Split filtered links into N groups..." min={2} max={100} /></div>
            <div className="input-wrap" style={{ flex: 1 }}>
              <input type="number" className="no-icon" value={fPerGroup} onChange={(e) => setFPerGroup(e.target.value)} placeholder="Links per group..." min={1} />
            </div>
          </div>
          <div className="filter-row">
            <div className="input-wrap" style={{ flex: 1 }}><I.Split /><input type="text" value={fGroupKeywords} onChange={(e) => setFGroupKeywords(e.target.value)} placeholder="Group by keywords (e.g. 1080p 2160p CAM)" /></div>
          </div>
          {fSplit && fPerGroup && !fGroupKeywords.trim() && (
            <p className="hint" style={{ color: "var(--mv-amber, #f59e0b)", marginTop: "0.1rem" }}>
              ⚠ Both split fields set — "Links per group" takes priority; N groups is ignored.
            </p>
          )}
          {fGroupKeywords.trim() && (
            <p className="hint" style={{ color: "var(--mv-amber, #f59e0b)", marginTop: "0.1rem" }}>
              ⚠ Keyword grouping is active — each space-separated keyword becomes its own group (first match wins), links matching none go to "Ungrouped". Split settings above are ignored while this is set.
            </p>
          )}
        </section>

        {/* Status bar */}
        <div className="status-bar">
          <span className={`status-dot ${connected ? "connected" : "disconnected"}`} />
          <span className={`status-label ${connected ? "connected" : "disconnected"}`}>{statusLabel}</span>
          <span className="status-count">{filteredLinks.length} / {allLinks.length} shown</span>
          {lastTagById.size > 0 && (
            <span className="status-count" title="Untag Visible / Untag matches / Restore Tags only change what's displayed — Sync reloads the real, saved tags from the database.">
              · {lastTagById.size} tag{lastTagById.size !== 1 ? "s" : ""} altered locally (not saved)
            </span>
          )}
        </div>

        {/* Actions — flex-wrap so the row wraps onto multiple lines instead
            of forcing horizontal scroll on narrow screens. */}
        <div
          className="action-bar"
          style={{ flexWrap: "wrap", overflowX: "visible", rowGap: "0.5rem" }}
        >
          <button className={`btn${copyAllPrimary ? " btn-primary" : ""}`} disabled={syncing} onClick={handleCopyAll}><I.Copy />{copyAllLabel} (as is)</button>
          <button className="btn" disabled={syncing} onClick={handleCopyTag}><I.Tag />Copy as Tag</button>
          <button className="btn" disabled={syncing} onClick={handleCopyPlain}><I.TagOff />Copy as Plain</button>
          <button className="btn" disabled={taggedVisibleCount === 0} onClick={handleUntagVisible}><I.TagOff />{untagVisibleLabel}</button>
          <button className="btn" disabled={restorableVisibleCount === 0} onClick={handleRestorePreviousTags}><I.Tag />{restoreTagsLabel}</button>
          <button className="btn" disabled={syncing} onClick={handleSortAlpha}><I.Sort />Sort A–Z</button>
          <button className="btn" disabled={syncing} onClick={handleSortEpisode}><I.Sort />Sort by Episode</button>
          <button className="btn" disabled={syncing} onClick={handleDedupe}><I.Dedupe />{dedupeLabel}</button>
          <button className="btn" disabled={syncing} onClick={handleExactDedupe}><I.Exact />{exactLabel}</button>
          <button className="btn" disabled={syncing} onClick={fetchLinks}><I.Sync spin={syncing} />Sync</button>
          <button className="btn btn-danger" disabled={syncing} onClick={handlePurgeFiltered}><I.TrashSlash />Purge Filtered</button>
          <button className="btn btn-danger" disabled={syncing} onClick={handlePurge}><I.Fire />Purge Vault</button>
        </div>

        {/* Link container */}
        <div id="link-container">
          {groups ? (
            groups.every((g) => g.items.length === 0)
              ? <div className="empty-state">🐠 No links match the current filters.</div>
              : groups.map((g, idx) => (
                <div className="group-block" key={idx}>
                  <div className="group-header">
                    <div className="group-title">
                      🐠 {g.label}<span style={{ fontWeight: 400, color: "var(--mv-muted)", fontSize: "0.65rem" }}>of {groups.length}</span>
                      <span className="group-badge">{g.items.length} link{g.items.length !== 1 ? "s" : ""}</span>
                    </div>
                    <button className="group-copy-btn" onClick={() => copyGroup(idx)}><I.Copy />Copy {g.label}</button>
                  </div>
                  {g.items.length === 0
                    ? <div className="empty-state" style={{ padding: "1.25rem 1rem", fontSize: "0.72rem" }}>No links in this group.</div>
                    : <ul className="link-list-wrap" role="list" style={{ border: "none", borderRadius: 0, background: "transparent" }}>
                        {g.items.map((l) => <HttpLinkRow key={l.id} l={l} selected={selectedIds.has(l.id)} onToggle={toggleSelect} onCopy={copyText} onDelete={handleDelete} onUntag={handleUntag} onRetag={handleRetag} />)}
                      </ul>}
                </div>
              ))
          ) : !filteredLinks.length ? (
            <div className="empty-state">
              🐠 {allLinks.length === 0 ? "No links found in the vault. Add some below!" : "No links match the current filters."}
            </div>
          ) : (
            <ul className="link-list-wrap" role="list">
              {filteredLinks.map((l) => <HttpLinkRow key={l.id} l={l} selected={selectedIds.has(l.id)} onToggle={toggleSelect} onCopy={copyText} onDelete={handleDelete} onUntag={handleUntag} onRetag={handleRetag} />)}
            </ul>
          )}
        </div>

        {/* Dedupe Priority */}
        <details className="mv-collapse">
          <summary><I.Chevron /><svg style={{ width: "0.85rem", height: "0.85rem", color: "var(--mv-violet)" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m18 15-6-6-6 6" /></svg>Dedupe Priority Words</summary>
          <div className="collapsible-body">
            <p className="hint">Choose how the Dedupe button picks which copy of a duplicate episode to keep.</p>

            <div className="dedupe-mode-row">
              <div className="radio-group">
                <label className="radio-option">
                  <input type="radio" name="dedupeMode" checked={dedupeMode === "priority"} onChange={() => setDedupeMode("priority")} />
                  <span className="radio-dot" />
                  Priority words
                </label>
                <label className="radio-option">
                  <input type="radio" name="dedupeMode" checked={dedupeMode === "first"} onChange={() => setDedupeMode("first")} />
                  <span className="radio-dot" />
                  Keep first (as shown)
                </label>
                <label className="radio-option">
                  <input type="radio" name="dedupeMode" checked={dedupeMode === "last"} onChange={() => setDedupeMode("last")} />
                  <span className="radio-dot" />
                  Keep last (as shown)
                </label>
              </div>
              <button className="btn" onClick={handleUnhideAll}><I.EyeOff />Unhide all</button>
            </div>

            {dedupeMode === "priority" && (
              <>
                <p className="hint"><em>When in Priority words mode</em>, the copy whose link or title contains the highest-ranking word is kept. Use arrows to rank.</p>
                <div className="priority-list">
                  {priorityWords.length === 0
                    ? <div className="empty-state" style={{ padding: "1rem", fontSize: "0.7rem" }}>No priority words set.</div>
                    : priorityWords.map((word, index) => (
                      <div className="priority-item" key={word + index}>
                        <span className="priority-word">{word.toUpperCase()}</span>
                        <button className="prio-btn" onClick={() => movePriority(index, -1)} disabled={index === 0} aria-label="Move up"><I.ArrowUp /></button>
                        <button className="prio-btn" onClick={() => movePriority(index, 1)} disabled={index === priorityWords.length - 1} aria-label="Move down"><I.ArrowDown /></button>
                        <button className="prio-btn del" onClick={() => removePriority(index)} aria-label="Remove"><I.X /></button>
                      </div>
                    ))}
                </div>
                <div className="add-btn-row">
                  <div className="input-wrap" style={{ flex: 1 }}>
                    <input type="text" className="no-icon" value={newPrio} onChange={(e) => setNewPrio(e.target.value)} placeholder="Add priority keyword..." onKeyDown={(e) => { if (e.key === "Enter") addPriorityWord(); }} />
                  </div>
                  <button className="btn btn-primary" onClick={addPriorityWord}><I.Plus />Add</button>
                </div>
                <div className="input-wrap" style={{ marginTop: "0.5rem" }}>
                  <input type="text" className="no-icon" value={dedupeIgnore} onChange={(e) => setDedupeIgnore(e.target.value)} placeholder="Phrase to ignore when scoring (e.g. CAM)" />
                </div>
              </>
            )}

            <p className="hint" style={{ marginTop: "0.85rem" }}>Hide any link whose title or URL contains a specific phrase (case-insensitive). Only matching links are hidden — nothing else changes. Refresh to restore.</p>
            <div className="add-btn-row">
              <div className="input-wrap" style={{ flex: 1 }}>
                <input type="text" className="no-icon" value={hidePhrase} onChange={(e) => setHidePhrase(e.target.value)} placeholder="Phrase to hide (e.g. CAM)" onKeyDown={(e) => { if (e.key === "Enter") handleHidePhrase(); }} />
              </div>
              <button className="btn" onClick={handleHidePhrase}><I.EyeOff />Hide matches</button>
              <button className="btn" onClick={() => handleHideAboveBelow("above")}><I.EyeOff />Hide that + above</button>
              <button className="btn" onClick={() => handleHideAboveBelow("below")}><I.EyeOff />Hide that + below</button>
            </div>
          </div>
        </details>

        {/* Add Links */}
        <details className="mv-collapse" open>
          <summary><I.Chevron /><svg style={{ width: "0.85rem", height: "0.85rem", color: "var(--mv-violet)" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5v14" /></svg>Add Links Manually</summary>
          <div className="collapsible-body">
            <p className="hint">Paste one or more http(s) links. Links pasted back-to-back with no space between them (e.g. "https://buffer.comhttps://outlook.com") are split automatically. Tagged links (e.g. "https://...file.mkv|Release.Name") are supported too and are kept as-is, tag included — the title is still derived from the URL itself, not the tag.</p>
            <div className="add-form">
              <div className="input-wrap"><input type="text" className="no-icon" value={addTitle} onChange={(e) => setAddTitle(e.target.value)} placeholder="Title (auto-filled from URL if blank)" /></div>
              <textarea rows={3} value={addUrl} onChange={(e) => autoFillTitle(e.target.value)} placeholder="https://... or https://...|Tagged.Name" />
              <div className="add-btn-row">
                <button className="btn btn-primary" disabled={syncing} onClick={handleAdd}><I.Plus />Add</button>
                <button className="btn" disabled={syncing} onClick={handlePasteAdd}><I.Dedupe />Add all pasted</button>
              </div>
            </div>
            <p className="hint" style={{ marginTop: "0.85rem" }}>Untag any tagged link whose title or URL contains a keyword (case-insensitive). Comma-separate multiple keywords to match any of them. Applied locally only — the plain URL is shown, and Sync will restore the real, saved tags from the database.</p>
            <div className="add-btn-row">
              <div className="input-wrap" style={{ flex: 1 }}>
                <input type="text" className="no-icon" value={untagFilter} onChange={(e) => setUntagFilter(e.target.value)} placeholder="Keyword(s) to untag, comma-separated (e.g. EDGE2020, YIFY)" onKeyDown={(e) => { if (e.key === "Enter") handleUntagFilter(); }} />
              </div>
              <button className="btn" onClick={handleUntagFilter}><I.TagOff />Untag matches</button>
            </div>
            <p className="hint" style={{ marginTop: "0.85rem" }}>Tag every link whose title or URL contains a keyword (case-insensitive), setting the given tag on all of them. Comma-separate multiple keywords to match any of them. This is saved to the database immediately and overwrites any existing tag on matching links.</p>
            <div className="add-btn-row">
              <div className="input-wrap" style={{ flex: 1 }}>
                <input type="text" className="no-icon" value={batchTagFilter} onChange={(e) => setBatchTagFilter(e.target.value)} placeholder="Keyword(s) to match, comma-separated (e.g. EDGE2020, YIFY)" />
              </div>
              <div className="input-wrap" style={{ flex: 1 }}>
                <input type="text" className="no-icon" value={batchTagValue} onChange={(e) => setBatchTagValue(e.target.value)} placeholder="Tag to apply (e.g. Release.Name)" onKeyDown={(e) => { if (e.key === "Enter") handleBatchTag(); }} />
              </div>
              <button className="btn" disabled={syncing} onClick={handleBatchTag}><I.Tag />Batch Tag</button>
            </div>
          </div>
        </details>
      </div>

      {/* Toasts */}
      <div className="mv-toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} role="status">
            {t.kind === "ok" ? <I.Check /> : <I.X />}
            <span>{t.msg}</span>
          </div>
        ))}
      </div>

      {/* Confirm modal */}
      {confirmation && (
        <div className="mv-overlay" onClick={(e) => { if (e.target === e.currentTarget) setConfirmation(null); }} role="dialog" aria-modal="true">
          <div className="mv-modal">
            <div className="mv-modal-title">{confirmation.title}</div>
            <div className="mv-modal-body">{confirmation.body}</div>
            <div className="mv-modal-actions">
              <button className="btn" onClick={() => setConfirmation(null)}>Cancel</button>
              <button
                className={confirmation.danger ? "btn btn-danger" : "btn btn-primary"}
                onClick={() => { const fn = confirmation.onConfirm; setConfirmation(null); fn(); }}
              >Confirm</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
