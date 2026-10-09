// GET /p/<item id>: the link to share for one piece. Social apps and messengers read its preview
// tags (the piece's name, price and photo); people who open it go straight on to the piece in the
// shop (/p.js, a same-origin script, so the site's Content-Security-Policy allows it).
import { ALLOWED_ORIGIN } from "./config.mjs";
import { loadCatalog } from "./catalog.mjs";

const esc = (s = "") => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const money = (cents, currency = "USD") => new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
const html = (status, body, cache) => ({
  statusCode: status,
  headers: { "content-type": "text/html; charset=utf-8", "cache-control": cache },
  body,
});

/** The first line of a description: the spec line ("Cone 10 porcelain · celadon · 5½″ × 3″"). */
export const specLine = (description = "") =>
  description
    .split(/\r?\n/)
    .find((l) => l.trim())
    ?.trim() ?? "";

export async function piece(id) {
  const site = ALLOWED_ORIGIN === "*" ? "" : ALLOWED_ORIGIN;
  const item = /^[A-Za-z0-9_-]{1,64}$/.test(id) ? (await loadCatalog()).find((i) => i.id === id) : undefined;
  // 410 Gone, not 404: CloudFront swaps every 403/404 for the site's error page (deploy/site.yaml), and
  // someone following an old share link should hear that the piece has gone, with a way to the shop.
  if (!item)
    return html(
      410,
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Piece not found · Updraft Pottery Studio</title>` +
        `<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"></head><body>` +
        `<p>That piece isn't listed any more. <a href="/shop.html">See what's in the shop</a>.</p></body></html>`,
      "public, max-age=60",
    );

  const available = item.variations.filter((v) => v.stock !== 0);
  const price = available.length
    ? `${new Set(available.map((v) => v.price)).size > 1 ? "From " : ""}${money(Math.min(...available.map((v) => v.price)), available[0].currency)}`
    : "Sold";
  const shopUrl = `/shop.html#p-${item.id}`;
  const description = specLine(item.description) || "Handmade in Tacoma by Updraft Pottery Studio.";
  const image = item.image ? `${site}/api/img?u=${encodeURIComponent(item.image)}&w=1200&f=jpeg` : `${site}/favicon.svg`;
  const tags = [
    `<meta property="og:type" content="product">`,
    `<meta property="og:site_name" content="Updraft Pottery Studio">`,
    `<meta property="og:title" content="${esc(`${item.name} · ${price}`)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:url" content="${esc(`${site}/p/${item.id}`)}">`,
    `<meta property="og:image" content="${esc(image)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
  ];
  return html(
    200,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(item.name)} · Updraft Pottery Studio</title>` +
      `<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="${esc(description)}">` +
      // The shop is the page search engines should list; this one only exists to be shared.
      `<meta name="robots" content="noindex"><link rel="canonical" href="${esc(`${site}/shop.html`)}">` +
      tags.join("") +
      `<script src="/p.js" defer></script></head><body>` +
      `<p><a href="${esc(shopUrl)}">${esc(item.name)} (${esc(price)}) at Updraft Pottery Studio</a></p></body></html>`,
    "public, max-age=300",
  );
}
