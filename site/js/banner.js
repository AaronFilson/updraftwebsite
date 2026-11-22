// Site-wide announcement banner (site/data/site.json -> site/partials/header.html).
// scripts/build.mjs omits an expired banner at build time; this removes one whose data-until
// passes between publishes, on every page (imported by both site.js and shop.js).

/**
 * Removes an announcement banner once its `data-until` timestamp has passed.
 * @param {ParentNode} [root]
 * @param {number} [now]
 */
export function syncBanner(root = document, now = Date.now()) {
  const banner = /** @type {HTMLElement | null} */ (root.querySelector(".sale-banner[data-until]"));
  if (!banner) return;
  const until = Date.parse(banner.dataset.until ?? "");
  if (!Number.isNaN(until) && now >= until) banner.remove();
}

if (typeof document !== "undefined" && typeof document.querySelector === "function") syncBanner();
