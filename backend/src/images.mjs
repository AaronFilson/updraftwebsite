// GET /api/img?u=<Square photo URL>&w=<width>&f=<avif|webp|jpeg>: a shop photo, resized and
// re-encoded (its own Lambda function; deploy-api.mjs ships sharp's Linux build with it). Square
// serves full-size originals, around 1 MB each, where a card needs a few tens of KB. CloudFront
// caches every variant for a year, so each photo is processed once per size and format.
// Only Square's photo hosts and a few fixed sizes are accepted, so this can't be used as a general
// proxy or to make the function do unbounded work.

const HOSTS = new Set(["items-images-production.s3.us-west-2.amazonaws.com", "items-images-sandbox.s3.us-west-2.amazonaws.com"]);
export const WIDTHS = [400, 800, 1200, 1600];
// Same settings as the site's own photos (scripts/build.mjs), plus JPEG for share previews.
const ENCODE = {
  avif: (w) => ({ quality: w <= 400 ? 48 : 52, effort: 4 }),
  webp: (w) => ({ quality: w <= 400 ? 70 : 76, effort: 6 }),
  jpeg: () => ({ quality: 80, mozjpeg: true }),
};
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

/** Validates the query; returns { url, width, format } or { error }. */
export function parseRequest(q = {}) {
  let url;
  try {
    url = new URL(String(q.u ?? ""));
  } catch {
    return { error: "u must be a Square photo URL" };
  }
  if (url.protocol !== "https:" || !HOSTS.has(url.hostname) || url.username || url.password || url.port)
    return { error: "u must be a Square photo URL" };
  const width = Number(q.w);
  if (!WIDTHS.includes(width)) return { error: `w must be one of ${WIDTHS.join(", ")}` };
  const format = String(q.f ?? "");
  if (!Object.hasOwn(ENCODE, format)) return { error: "f must be avif, webp or jpeg" };
  return { url: url.href, width, format };
}

const plain = (statusCode, text, cache = "no-store") => ({
  statusCode,
  headers: { "content-type": "text/plain; charset=utf-8", "cache-control": cache },
  body: text,
});

export async function handler(event) {
  const method = event.requestContext?.http?.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") return plain(405, "Method not allowed");
  const req = parseRequest(event.queryStringParameters ?? {});
  if (req.error) return plain(400, req.error);

  let src;
  try {
    const res = await fetch(req.url, { signal: AbortSignal.timeout(10_000) });
    // A missing photo stays missing for a while (the card falls back to Square's original).
    if (res.status === 403 || res.status === 404) return plain(404, "No such photo", "public, max-age=300");
    if (!res.ok) throw new Error(`source answered ${res.status}`);
    if (Number(res.headers.get("content-length") ?? 0) > MAX_SOURCE_BYTES) return plain(413, "Photo too large");
    src = Buffer.from(await res.arrayBuffer());
    if (src.length > MAX_SOURCE_BYTES) return plain(413, "Photo too large");
  } catch (err) {
    console.error("IMAGE_FETCH_FAILED", req.url, err.message);
    return plain(502, "Couldn't fetch the photo");
  }

  const { default: sharp } = await import("sharp");
  const out = await sharp(src, { limitInputPixels: 60_000_000 })
    .rotate() // honor the camera's orientation flag
    .resize({ width: req.width, withoutEnlargement: true })
    .toFormat(/** @type {"avif" | "webp" | "jpeg"} */ (req.format), ENCODE[req.format](req.width))
    .toBuffer();
  return {
    statusCode: 200,
    headers: { "content-type": `image/${req.format}`, "cache-control": "public, max-age=31536000, immutable" },
    body: out.toString("base64"),
    isBase64Encoded: true,
  };
}
