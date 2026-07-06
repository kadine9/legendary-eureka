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

// Tries HEAD first (cheap — no body transfer). Some hosts don't support
// HEAD, or only reveal Content-Disposition on GET, so if HEAD comes back
// without the header, fall back to a ranged GET that only pulls one byte.
async function probe(target: string): Promise<{ disposition: string | null; contentType: string | null }> {
  const head = await fetch(target, { method: "HEAD", redirect: "follow" });
  let disposition = head.headers.get("content-disposition");
  let contentType = head.headers.get("content-type");
  if (disposition) return { disposition, contentType };

  const ranged = await fetch(target, {
    method: "GET",
    redirect: "follow",
    headers: { Range: "bytes=0-0" },
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
