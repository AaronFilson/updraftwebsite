// Square product photos at the size they're shown. Square serves full-size originals (~1 MB);
// /api/img resizes and re-encodes them (backend/src/images.mjs) and CloudFront caches each copy.
// If a resized copy can't be loaded, the photo falls back to Square's original.

/** URL of a Square photo resized to width w (one of 400, 800, 1200, 1600) in format f. */
export const sized = (url, w, f) => `/api/img?u=${encodeURIComponent(url)}&w=${w}&f=${f}`;

/**
 * A <picture> offering AVIF, then WebP, at the given widths.
 * @param {string} url Square photo URL
 * @param {{ sizes: string, widths?: number[], alt?: string, eager?: boolean }} opts
 */
export function picture(url, { sizes, widths = [400, 800], alt = "", eager = false }) {
  const set = (f) => widths.map((w) => `${sized(url, w, f)} ${w}w`).join(", ");
  const source = Object.assign(document.createElement("source"), { type: "image/avif", srcset: set("avif"), sizes });
  const img = Object.assign(document.createElement("img"), {
    src: sized(url, widths[0], "webp"),
    srcset: set("webp"),
    sizes,
    alt,
    decoding: "async",
  });
  if (!eager) img.loading = "lazy";
  img.addEventListener(
    "error",
    () => {
      source.remove();
      img.removeAttribute("srcset");
      img.src = url;
    },
    { once: true },
  );
  const pic = document.createElement("picture");
  pic.append(source, img);
  return pic;
}
