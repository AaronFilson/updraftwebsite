// The page for one piece (/p/<item id>) and the pieces' sitemap (/p/sitemap.xml), drawn from catalog
// items. No Square or AWS here, so scripts/serve.mjs draws the same pages locally from a catalog file.
//
// The page goes into the site's own shell (dist/piece-shell.html, built with the header, footer,
// styles and scripts of every page): the piece replaces [[piece]] in <main>, its title replaces the
// shell's, and its head tags go before </head>. Without a shell it is a plain page that search
// engines are asked not to list, so a passing failure is never what they keep.

const SITE_NAME = "Updraft Pottery Studio";
const esc = (s = "") => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
// JSON inside a <script> block: "<" written as an escape, so nothing in it can close the tag.
const jsonForScript = (data) => JSON.stringify(data).replace(/</g, "\\u003c");
const money = (cents, currency = "USD") => new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
/** A Square photo resized by /api/img (backend/src/images.mjs); widths 400, 800, 1200, 1600. */
const sized = (url, w, f) => `/api/img?u=${encodeURIComponent(url)}&w=${w}&f=${f}`;

/** The first line of a description: the spec line ("Cone 10 porcelain · celadon · 5½″ × 3″"). */
export const specLine = (description = "") =>
  description
    .split(/\r?\n/)
    .find((l) => l.trim())
    ?.trim() ?? "";

/** The description after the spec line, as paragraphs. */
export function descriptionRest(description = "") {
  const lines = description.split(/\r?\n/).map((l) => l.trim());
  const first = lines.findIndex(Boolean);
  return first < 0 ? [] : lines.slice(first + 1).filter(Boolean);
}

const isOpen = (v) => (v.stock ?? null) !== 0;
const photosOf = (item) => (item.images?.length ? item.images : item.image ? [item.image] : []);

/** "$65.00", "From $40.00" (options differ in price) or "Sold". */
export function priceText(item) {
  const open = item.variations.filter(isOpen);
  if (!open.length) return "Sold";
  const low = Math.min(...open.map((v) => v.price));
  return `${new Set(open.map((v) => v.price)).size > 1 ? "From " : ""}${money(low, open[0].currency)}`;
}

/** The search-result description: the spec line, then where it was made. */
export function metaDescription(item) {
  const spec = specLine(item.description);
  return spec ? `${spec}. Handmade in Tacoma by ${SITE_NAME}.` : `Handmade in Tacoma by ${SITE_NAME}.`;
}

function picture(url, { alt, sizes, widths, eager }) {
  const set = (f) => widths.map((w) => `${sized(url, w, f)} ${w}w`).join(", ");
  // data-original: Square's full-size photo, which piece-page.js shows if the resized one can't load.
  return (
    `<picture><source type="image/avif" srcset="${esc(set("avif"))}" sizes="${sizes}">` +
    `<img src="${esc(sized(url, widths[0], "webp"))}" srcset="${esc(set("webp"))}" sizes="${sizes}" width="800" height="800"` +
    ` alt="${esc(alt)}" data-original="${esc(url)}"${eager ? ' fetchpriority="high"' : ' loading="lazy"'} decoding="async"></picture>`
  );
}

/** schema.org data: the Product with an Offer per option, and where it sits in the shop. */
export function structuredData(item, site) {
  const url = `${site}/p/${item.id}`;
  const many = item.variations.length > 1;
  const crumbs = [
    { name: "Shop", item: `${site}/shop.html` },
    ...(item.category ? [{ name: item.category, item: `${site}/shop.html?type=${encodeURIComponent(item.category)}` }] : []),
    { name: item.name, item: url },
  ];
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Product",
        "@id": `${url}#product`,
        name: item.name,
        description: item.description?.trim() || metaDescription(item),
        url,
        sku: item.id,
        image: photosOf(item).map((p) => site + sized(p, 1200, "jpeg")),
        ...(item.category ? { category: item.category } : {}),
        brand: { "@type": "Brand", name: SITE_NAME },
        offers: item.variations.map((v) => ({
          "@type": "Offer",
          ...(many ? { name: v.name } : {}),
          url,
          price: (v.price / 100).toFixed(2),
          priceCurrency: v.currency ?? "USD",
          availability: isOpen(v) ? "https://schema.org/InStock" : "https://schema.org/SoldOut",
          itemCondition: "https://schema.org/NewCondition",
          seller: { "@type": "Organization", name: SITE_NAME, url: `${site}/` },
          // policies.html: returns are not accepted (a piece broken in shipping is refunded).
          hasMerchantReturnPolicy: {
            "@type": "MerchantReturnPolicy",
            applicableCountry: "US",
            returnPolicyCategory: "https://schema.org/MerchantReturnNotPermitted",
          },
        })),
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: crumbs.map((c, n) => ({ "@type": "ListItem", position: n + 1, ...c })),
      },
    ],
  };
}

function headTags(item, site) {
  const url = `${site}/p/${item.id}`;
  const photo = photosOf(item)[0];
  const open = item.variations.filter(isOpen);
  return [
    `<meta name="description" content="${esc(metaDescription(item))}">`,
    `<link rel="canonical" href="${esc(url)}">`,
    `<meta property="og:type" content="product">`,
    `<meta property="og:site_name" content="${SITE_NAME}">`,
    `<meta property="og:title" content="${esc(`${item.name} · ${priceText(item)}`)}">`,
    `<meta property="og:description" content="${esc(specLine(item.description) || metaDescription(item))}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta property="og:image" content="${esc(photo ? site + sized(photo, 1200, "jpeg") : `${site}/favicon.svg`)}">`,
    // Read by Facebook and Pinterest for the price on a shared piece.
    ...(open.length
      ? [
          `<meta property="product:price:amount" content="${(Math.min(...open.map((v) => v.price)) / 100).toFixed(2)}">`,
          `<meta property="product:price:currency" content="${esc(open[0].currency ?? "USD")}">`,
        ]
      : []),
    `<meta name="twitter:card" content="summary_large_image">`,
    `<script type="application/ld+json">${jsonForScript(structuredData(item, site))}</script>`,
  ].join("");
}

function moreCard(item) {
  const photo = photosOf(item)[0];
  return (
    `<a class="card product-link" href="/p/${esc(item.id)}">` +
    (photo
      ? picture(photo, { alt: "", sizes: "(max-width: 599px) 46vw, 260px", widths: [400, 800], eager: false })
      : '<div class="ph"></div>') +
    `<div class="card-body"><h3>${esc(item.name)}</h3><span class="price">${esc(priceText(item))}</span></div></a>`
  );
}

/** What goes in <main>: photos, words, price, the way to buy, and a few other pieces. */
function body(item, items, { policies }) {
  const photos = photosOf(item);
  const sold = !item.variations.some(isOpen);
  const spec = specLine(item.description);
  const gallery = photos.length
    ? photos
        .map((p, i) =>
          picture(p, {
            alt: `${item.name}, photo ${i + 1}`,
            sizes: i ? "(min-width: 900px) 270px, 50vw" : "(min-width: 900px) 560px, 100vw",
            widths: [800, 1600], // the sizes scripts/warm-photos.mjs makes for every photo
            eager: i === 0,
          }),
        )
        .join("")
    : '<div class="ph"></div>';
  const others = items.filter((i) => i.id !== item.id && i.variations.some(isOpen)).slice(0, 4);
  // For piece-page.js, which turns the link below into Add to cart; stock as of this page.
  const data = {
    id: item.id,
    name: item.name,
    variations: item.variations.map(({ id, name, price, currency, stock }) => ({ id, name, price, currency, stock: stock ?? null })),
  };
  return (
    `<div class="wrap piece-page">` +
    `<nav class="crumbs" aria-label="Breadcrumb"><ol><li><a href="/shop.html">Shop</a></li>` +
    (item.category ? `<li><a href="/shop.html?type=${esc(encodeURIComponent(item.category))}">${esc(item.category)}</a></li>` : "") +
    `<li><span aria-current="page">${esc(item.name)}</span></li></ol></nav>` +
    `<div class="piece-layout"><div class="piece-gallery${sold ? " is-sold" : ""}">${gallery}</div>` +
    `<div class="piece-about"><h1>${esc(item.name)}</h1>` +
    (spec ? `<p class="piece-spec">${esc(spec)}</p>` : "") +
    `<div class="piece-desc">${descriptionRest(item.description)
      .map((t) => `<p>${esc(t)}</p>`)
      .join("")}</div>` +
    `<div class="piece-buy" id="piece-buy"><p class="price">${esc(priceText(item))}</p>` +
    (sold
      ? `<p class="muted">This piece has found a home. <a href="/shop.html">See what's available</a>.</p>`
      : `<p><a class="btn" href="/shop.html#p-${esc(item.id)}">Buy in the shop</a></p>`) +
    `</div>` +
    `<p class="piece-more"><a href="/care.html">Care &amp; use</a>` +
    (policies ? `<a href="/policies.html">Shipping, pickup &amp; returns</a>` : "") +
    `</p></div></div>` +
    (others.length
      ? `<section class="more-pieces" aria-labelledby="more-title"><h2 id="more-title">More in the shop</h2>` +
        `<div class="grid product-strip">${others.map(moreCard).join("")}</div>` +
        `<p class="more"><a href="/shop.html">See everything in the shop →</a></p></section>`
      : "") +
    `</div><script type="application/json" id="piece-data">${jsonForScript(data)}</script>`
  );
}

/**
 * The whole page for one piece.
 * @param {{ item: any, items: any[], shell?: string | null, site: string }} opts
 *   site: the address pages are linked from, e.g. https://updraftpotterystudio.com ("" when unknown)
 */
export function renderPiece({ item, items, shell, site }) {
  const title = `${esc(item.name)} | ${SITE_NAME}`;
  if (shell?.includes("[[piece]]"))
    return shell
      .replace(/<title>[^<]*<\/title>/, () => `<title>${title}</title>`)
      .replace("</head>", () => `${headTags(item, site)}</head>`)
      .replace("[[piece]]", () => body(item, items, { policies: shell.includes('href="/policies.html"') }));
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">` +
    `${headTags(item, site)}</head><body><main>${body(item, items, { policies: false })}</main></body></html>`
  );
}

/** The page for a piece that is no longer listed (archived or deleted in Square). */
export const gonePage = () =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Piece not found · ${SITE_NAME}</title>` +
  `<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"></head><body>` +
  `<p>That piece isn't listed any more. <a href="/shop.html">See what's in the shop</a>.</p></body></html>`;

/** Every listed piece, sold ones too: their pages stay up. */
export function piecesSitemap(items, site) {
  const urls = items.map(
    (i) => `  <url><loc>${esc(`${site}/p/${i.id}`)}</loc>${i.updatedAt ? `<lastmod>${esc(i.updatedAt.slice(0, 10))}</lastmod>` : ""}</url>`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}
