// GET /api/img?u=<Square photo URL>&w=<width>&f=<avif|webp|jpeg>: a shop photo, resized and
// re-encoded (its own Lambda function; deploy-api.mjs ships sharp's Linux build with it). Square
// serves full-size originals, around 1 MB each, where a card needs a few tens of KB. CloudFront
// caches every variant for a year, so each photo is processed once per size and format.
// Only photos in this shop's own catalog and a few fixed sizes are accepted, so this can't resize
// anyone else's photos, and the work anyone can cause is bounded: the shop's photos × 4 sizes × 3
// formats, each done once.

const HOSTS = {
  production: "items-images-production.s3.us-west-2.amazonaws.com",
  sandbox: "items-images-sandbox.s3.us-west-2.amazonaws.com",
};
export const WIDTHS = [400, 800, 1200, 1600];
// Same settings as the site's own photos (scripts/build.mjs), plus JPEG for share previews.
const ENCODE = {
  avif: (w) => ({ quality: w <= 400 ? 48 : 52, effort: 4 }),
  webp: (w) => ({ quality: w <= 400 ? 70 : 76, effort: 6 }),
  jpeg: () => ({ quality: 80, mozjpeg: true }),
};
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
// A function URL response is at most 6 MB, and the body goes base64-encoded (4/3 larger).
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Validates the query; returns { url, width, format } or { error }. */
export function parseRequest(q = {}, env = process.env.SQUARE_ENV) {
  const u = String(q.u ?? "");
  let url;
  try {
    url = new URL(u);
  } catch {
    return { error: "u must be a Square photo URL" };
  }
  // Exactly as Square wrote it (so no variant of a URL is a new cache entry), on this stage's host.
  if (url.href !== u || url.protocol !== "https:" || url.hostname !== HOSTS[env === "production" ? "production" : "sandbox"])
    return { error: "u must be a Square photo URL" };
  if (url.username || url.password || url.port || url.search || url.hash) return { error: "u must be a Square photo URL" };
  const width = Number(q.w);
  if (!WIDTHS.includes(width)) return { error: `w must be one of ${WIDTHS.join(", ")}` };
  const format = String(q.f ?? "");
  if (!Object.hasOwn(ENCODE, format)) return { error: "f must be avif, webp or jpeg" };
  return { url: u, width, format };
}

// The shop's photos, from its own catalog (through CloudFront, like a visitor). Re-read when a photo
// isn't in it, at most every 20 seconds, so a piece added in Square shows its photo within a minute.
let known = { at: 0, urls: new Set() };
let reading;
async function readCatalog() {
  const res = await fetch(`${process.env.ALLOWED_ORIGIN}/api/catalog`, { signal: AbortSignal.timeout(8_000), redirect: "error" });
  if (!res.ok) throw new Error(`catalog answered ${res.status}`);
  const { items = [] } = await res.json();
  known = { at: Date.now(), urls: new Set(items.flatMap((i) => [i.image, ...(i.images ?? [])]).filter(Boolean)) };
}
async function isShopPhoto(url) {
  if (!known.urls.has(url) && Date.now() - known.at > 20_000) await (reading ??= readCatalog().finally(() => (reading = undefined)));
  return known.urls.has(url);
}
// For tests: forget the catalog read so far.
export const _resetCatalog = () => {
  known = { at: 0, urls: new Set() };
};

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

  try {
    if (!(await isShopPhoto(req.url))) return plain(404, "Not one of the shop's photos", "public, max-age=60");
  } catch (err) {
    console.error("IMAGE_CATALOG_FAILED", err.message);
    return plain(503, "Couldn't check the photo");
  }

  let src;
  try {
    const res = await fetch(req.url, { signal: AbortSignal.timeout(10_000), redirect: "error" });
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

  let out;
  try {
    const { default: sharp } = await import("sharp");
    out = await sharp(src, { limitInputPixels: 60_000_000 })
      .rotate() // honor the camera's orientation flag
      // Tall photos are bounded too (twice the width), so no output is unexpectedly large.
      .resize({ width: req.width, height: req.width * 2, fit: "inside", withoutEnlargement: true })
      .toFormat(/** @type {"avif" | "webp" | "jpeg"} */ (req.format), ENCODE[req.format](req.width))
      .toBuffer();
  } catch (err) {
    // Not an image sharp can read (or too many pixels). Kept for a while: the same bytes fail again.
    console.error("IMAGE_DECODE_FAILED", req.url, err.message);
    return plain(422, "Couldn't read the photo", "public, max-age=300");
  }
  if (out.length > MAX_OUTPUT_BYTES) {
    console.error("IMAGE_TOO_LARGE", req.url, req.width, req.format, out.length);
    return plain(413, "Photo too large");
  }
  return {
    statusCode: 200,
    headers: { "content-type": `image/${req.format}`, "cache-control": "public, max-age=31536000, immutable" },
    body: out.toString("base64"),
    isBase64Encoded: true,
  };
}
