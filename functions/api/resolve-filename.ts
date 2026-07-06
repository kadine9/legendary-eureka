// Cloudflare Pages Function — GET /api/resolve-filename?url=<encoded target>
//
// Purpose: direct-download links often reveal their real filename via a
// `Content-Disposition: attachment; filename="Show.S01E02.mkv"` response
// header on a HEAD/GET request. Reading that header from the browser
// usually fails silently, though, because most third-party file hosts
// don't send permissive CORS headers (`Access-Control-Allow-Origin`), so
// the browser blocks the response before client-side JS can see it.
//
// This function makes the same request server-side instead, where CORS
// doesn't apply (CORS is a browser-enforced rule, not a server-enforced
// one), and hands back just the parsed filename over our own origin —
// which the browser is always allowed to read.
export const onRequestGet = async (context: { request: Request }) => {
  const requestUrl = new URL(context.request.url);
  const target = requestUrl.searchParams.get("url");

  if (!target || !/^https?:\/\//i.test(target)) {
    return json({ error: "Missing or invalid 'url' query parameter" }, 400);
  }

  try {
    const { disposition, contentType } = await probe(target);
    const filename = parseContentDispositionFilename(disposition);
    return json({ filename, contentType }, 200, { "cache-control": "public, max-age=3600" });
  } catch (err) {
    return json({ error: "Fetch failed", detail: String((err as Error)?.message || err) }, 502);
  }
};

// Workers' outbound fetch() doesn't send the browser-like headers a real
// client would (no User-Agent, no Accept), and a lot of file hosts either
// reject bare requests outright or quietly respond with a generic page that
// carries no Content-Disposition. Presenting as an ordinary browser fixes
// both cases and shouldn't affect hosts that don't care either way.
const BROWSER_LIKE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9",
};

// Tries HEAD first (cheap — no body transfer). Some hosts don't support
// HEAD at all (they error, hang, or reset the connection rather than
// returning a clean 4xx), and others only reveal Content-Disposition on
// GET, so on any HEAD problem — thrown error, non-OK status, or a response
// simply missing the header — fall back to a ranged GET that only pulls
// one byte.
async function probe(target: string): Promise<{ disposition: string | null; contentType: string | null }> {
  let disposition: string | null = null;
  let contentType: string | null = null;

  try {
    const head = await fetch(target, { method: "HEAD", redirect: "follow", headers: BROWSER_LIKE_HEADERS });
    disposition = head.headers.get("content-disposition");
    contentType = head.headers.get("content-type");
    if (disposition) return { disposition, contentType };
  } catch {
    // HEAD outright failed (host doesn't support it, connection reset,
    // etc.) - fall through to the GET attempt below instead of giving up.
  }

  const ranged = await fetch(target, {
    method: "GET",
    redirect: "follow",
    headers: { ...BROWSER_LIKE_HEADERS, Range: "bytes=0-0" },
  });
  disposition = ranged.headers.get("content-disposition");
  contentType = ranged.headers.get("content-type") || contentType;
  return { disposition, contentType };
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

function json(body: unknown, status: number, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}
