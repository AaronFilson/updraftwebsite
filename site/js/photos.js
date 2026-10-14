// Square product photos at the size they're shown. Square serves full-size originals (~1 MB);
// /api/img resizes and re-encodes them (backend/src/images.mjs) and CloudFront caches each copy.
// If a resized copy can't be loaded, it's tried again a little later (the resizer answers 429 when
// more photos are asked for at once than its limit, imagesConcurrency in deploy/stages.json, which
// happens on the first visit after new pieces go up), then the photo falls back to Square's original.

/**
 * URL of a Square photo resized to width w (one of 400, 800, 1200, 1600) in format f. A retry adds
 * r=<n> so the browser asks again; CloudFront keys its cache on u, w and f only, so it's the same copy.
 */
export const sized = (url, w, f, retry = 0) => `/api/img?u=${encodeURIComponent(url)}&w=${w}&f=${f}${retry ? `&r=${retry}` : ""}`;

/** Waits before each retry of a resized photo that failed to load, in ms (about; jittered). */
export const RETRY_MS = [1000, 3000];

/**
 * A <picture> offering AVIF, then WebP, at the given widths.
 * @param {string} url Square photo URL
 * @param {{ sizes: string, widths?: number[], alt?: string, eager?: boolean }} opts
 */
export function picture(url, { sizes, widths = [400, 800], alt = "", eager = false }) {
  const pic = document.createElement("picture");
  // Each try gets new elements: browsers don't reliably show a photo that loads after the same
  // <img> failed.
  const attempt = (retry) => {
    const set = (f) => widths.map((w) => `${sized(url, w, f, retry)} ${w}w`).join(", ");
    const source = Object.assign(document.createElement("source"), { type: "image/avif", srcset: set("avif"), sizes });
    const img = Object.assign(document.createElement("img"), {
      src: sized(url, widths[0], "webp", retry),
      srcset: set("webp"),
      sizes,
      alt,
      decoding: "async",
    });
    if (!eager) img.loading = "lazy";
    img.addEventListener(
      "error",
      () => {
        const wait = RETRY_MS[retry];
        if (wait !== undefined) return setTimeout(() => attempt(retry + 1), wait * (0.75 + Math.random() / 2));
        const original = Object.assign(document.createElement("img"), { src: url, alt, decoding: "async" });
        pic.replaceChildren(original);
      },
      { once: true },
    );
    pic.replaceChildren(source, img);
  };
  attempt(0);
  return pic;
}
