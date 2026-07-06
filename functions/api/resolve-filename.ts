// Cloudflare Pages Function — GET /api/resolve-filename?url=<encoded target>
//
// Purpose: reveal a link's real name when the URL itself doesn't contain it.
// Two sources, in order of trustworthiness:
//   1. `Content-Disposition: attachment; filename="Show.S01E02.mkv"` —
//      the raw stored filename on the host, sent by direct-download links.
//   2. The landing page's <title> / <meta property="og:title"> — many file
//      hosts (pixeldrain, mega, gofile, mediafire, …) don't serve the file
//      directly on the shared URL but do put its real name in the page's
//      HTML title, so scraping that recovers a name the URL hides.
//
// Reading Content-Disposition from the browser almost always fails silently
// on third-party hosts (they don't send permissive
// `Access-Control-Allow-Origin`); reading cross-origin HTML has the same
// problem. This function makes those requests server-side, where CORS
// doesn't apply, and returns just the extracted values over our own origin
// — which the browser is always allowed to read.
export const onRequestGet = async (context: { request: Request }) => {
  const requestUrl = new URL(context.request.url);
  const target = requestUrl.searchParams.get("url");

  if (!target || !/^https?:\/\//i.test(target)) {
    return json({ error: "Missing or invalid 'url' query parameter" }, 400);
  }

  try {
    const { disposition, contentType, html } = await probe(target);
    const filename = parseContentDispositionFilename(disposition);
    const title = filename ? null : extractHtmlTitle(html, target);
    return json({ filename, title, contentType }, 200, { "cache-control": "public, max-age=3600" });
  } catch (err) {
    return json({ error: "Fetch failed", detail: String((err as Error)?.message || err) }, 502);
  }
};

// Tries HEAD first (cheap — no body transfer). Some hosts don't support
// HEAD, or only reveal Content-Disposition on GET, so if HEAD comes back
// without the header, fall back to a GET. When the response is HTML
// (the typical landing-page case), we grab the first ~64KB so the
// caller can extract <title> / og:title too.
async function probe(target: string): Promise<{ disposition: string | null; contentType: string | null; html: string | null }> {
  const head = await fetch(target, { method: "HEAD", redirect: "follow" });
  let disposition = head.headers.get("content-disposition");
  let contentType = head.headers.get("content-type");
  if (disposition) return { disposition, contentType, html: null };

  // GET — most hosts either reveal Content-Disposition here that they
  // withheld on HEAD, or serve an HTML page whose <title> we can scrape.
  // A Range header nudges direct-download hosts to send just one byte
  // instead of streaming a multi-GB file; HTML servers usually ignore it
  // and send the full page.
  const resp = await fetch(target, {
    method: "GET",
    redirect: "follow",
    headers: {
      Range: "bytes=0-65535",
      "User-Agent": "Mozilla/5.0 (compatible; LinkVaultBot/1.0)",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  disposition = resp.headers.get("content-disposition");
  contentType = resp.headers.get("content-type") || contentType;

  let html: string | null = null;
  if (!disposition && contentType && /text\/html|application\/xhtml/i.test(contentType)) {
    try {
      // Read at most 64KB — enough for <head> in every real-world HTML page,
      // and bounded so a misconfigured host that ignores Range can't drain
      // Worker memory / CPU time.
      const reader = resp.body?.getReader();
      if (reader) {
        const chunks: Uint8Array[] = [];
        let total = 0;
        const cap = 64 * 1024;
        while (total < cap) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          total += value.byteLength;
        }
        try { await reader.cancel(); } catch { /* ignore */ }
        const buf = new Uint8Array(Math.min(total, cap));
        let off = 0;
        for (const c of chunks) {
          const take = Math.min(c.byteLength, cap - off);
          buf.set(c.subarray(0, take), off);
          off += take;
          if (off >= cap) break;
        }
        html = new TextDecoder("utf-8", { fatal: false }).decode(buf);
      }
    } catch { /* body read failed - fall through with html=null */ }
  }

  return { disposition, contentType, html };
}

// Handles both the plain `filename="..."` form and the RFC 5987/6266
// encoded `filename*=UTF-8''...` form used for non-ASCII names.
function parseContentDispositionFilename(header: string | null): string | null {
  if (!header) return null;
  const starMatch = header.match(/filename\*\s*=\s*[^']*''([^;]+)/i);
  if (starMatch) {
    try {
      return decodeURIComponent(starMatch[1].trim().replace(/^"|"$/g, ""));
    } catch {
      // fall through to the plain form below
    }
  }
  const plainMatch = header.match(/filename\s*=\s*"?([^";]+)"?/i);
  if (plainMatch) return plainMatch[1].trim().replace(/^"|"$/g, "");
  return null;
}

// Extracts a display title from HTML, preferring og:title / twitter:title
// (which hosts curate specifically for share previews and usually contain
// just the filename) over <title> (which tends to append site branding
// like " ~ pixeldrain" or " | MediaFire"). Also strips that trailing
// " <sep> <hostname>" branding when only <title> is available.
function extractHtmlTitle(html: string | null, target: string): string | null {
  if (!html) return null;

  const metaMatch = (property: string) =>
    html.match(new RegExp(`<meta[^>]+(?:property|name)\\s*=\\s*["']${property}["'][^>]*>`, "i"))?.[0] ?? null;
  const contentOf = (tag: string | null) => tag?.match(/content\s*=\s*["']([^"']+)["']/i)?.[1]?.trim() || null;

  const og = contentOf(metaMatch("og:title"));
  if (og) return decodeEntities(og);
  const tw = contentOf(metaMatch("twitter:title"));
  if (tw) return decodeEntities(tw);

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    let t = decodeEntities(titleMatch[1].replace(/\s+/g, " ").trim());
    // Strip trailing site-name branding: " ~ pixeldrain", " | MediaFire",
    // " - Google Drive", " · gofile". Only strip when the trailing chunk
    // actually matches the request's host — otherwise a legitimate title
    // with a dash in it (e.g. "Foo - Bar") would be truncated.
    try {
      const host = new URL(target).hostname.replace(/^www\./i, "");
      const rootLabel = host.split(".").slice(-2, -1)[0] || host;
      const brandRe = new RegExp(
        `\\s*[~|·•\\-–—]\\s*[^~|·•\\-–—]*(?:${escapeRe(host)}|${escapeRe(rootLabel)})[^~|·•\\-–—]*$`,
        "i",
      );
      t = t.replace(brandRe, "").trim();
    } catch { /* ignore malformed target URL */ }
    if (t) return t;
  }
  return null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_m, n) => {
      try { return String.fromCodePoint(parseInt(n, 10)); } catch { return _m; }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => {
      try { return String.fromCodePoint(parseInt(n, 16)); } catch { return _m; }
    });
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function json(body: unknown, status: number, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}
