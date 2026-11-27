// The page for one piece (/p/<item id>) and the pieces' sitemap (/p/sitemap.xml), drawn from catalog
// items. No Square or AWS here, so scripts/serve.mjs draws the same pages locally from a catalog file.
//
// The page goes into the site's own shell (dist/piece-shell.html, built with the header, footer,
// styles and scripts of every page): the piece replaces [[piece]] in <main>, its title replaces the
// shell's, and its head tags go before </head>. Without a shell it is a plain page that search
// engines are asked not to list, so a passing failure is never what they keep.

import { shippingCents } from "./shipping.mjs";

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

/** Page <title>, adding "Handmade pottery" when the piece name has room (<= 60 characters). */
export function pieceTitle(item) {
  const name = String(item.name ?? "").trim();
  if (!/pottery|ceramic/i.test(name)) {
    const rich = `${name} – Handmade pottery | ${SITE_NAME}`;
    if (rich.length <= 60) return rich;
  }
  return `${name} | ${SITE_NAME}`;
}

function materialOf(item) {
  const text = `${item.name ?? ""} ${item.description ?? ""}`;
  if (/porcelain/i.test(text) && /stoneware/i.test(text)) return "Porcelain and stoneware";
  if (/porcelain/i.test(text)) return "Porcelain";
  if (/stoneware/i.test(text)) return "Stoneware";
  return "Ceramic";
}

const FRACTIONS = { "¼": 0.25, "½": 0.5, "¾": 0.75, "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875 };
const toInches = (whole, dec, frac) => (dec ? Number(`${whole}.${dec}`) : Number(whole) + (FRACTIONS[frac] ?? 0));
const qvIn = (n) => ({ "@type": "QuantitativeValue", value: +n.toFixed(3), unitCode: "INH" });

/** Parses dimensions (e.g. "9½″ × 3¾″" or "5½″ wide × 3″ tall") from a piece's spec line, in inches. */
export function parseDimensions(item) {
  const spec = specLine(item.description);
  if (!spec) return {};
  for (const raw of spec.split("·")) {
    const seg = raw.trim();
    if (!seg || seg.length > 60 || /,|\band\b|\bset\b/i.test(seg)) continue;
    const pair = seg.match(
      /^(\d{1,2})(?:\.(\d{1,2})|([¼½¾⅛⅜⅝⅞]))?\s*[″"]\s*(wide|across|tall|high)?\s*[×x]\s*(\d{1,2})(?:\.(\d{1,2})|([¼½¾⅛⅜⅝⅞]))?\s*[″"]\s*(wide|across|tall|high)?$/i,
    );
    if (pair) {
      const a = toInches(pair[1], pair[2], pair[3]);
      const la = (pair[4] ?? "").toLowerCase();
      const b = toInches(pair[5], pair[6], pair[7]);
      const lb = (pair[8] ?? "").toLowerCase();
      if (!(a > 0 && b > 0)) return {};
      const tallFirst =
        la === "tall" ||
        la === "high" ||
        lb === "wide" ||
        lb === "across" ||
        (!la && !lb && (item.category === "Vases" || /\b(vase|bottle|pitcher|ewer|cylinder|tower)\b/i.test(item.name ?? "")));
      return tallFirst ? { height: a, width: b } : { width: a, height: b };
    }
    const single = seg.match(/^(\d{1,2})(?:\.(\d{1,2})|([¼½¾⅛⅜⅝⅞]))?\s*[″"]\s*(wide|across)$/i);
    if (single) {
      const w = toInches(single[1], single[2], single[3]);
      return w > 0 ? { width: w } : {};
    }
  }
  return {};
}

const days = (minValue, maxValue) => ({ "@type": "QuantitativeValue", minValue, maxValue, unitCode: "DAY" });

/** Merchant-listing shipping details: WA Zone 2 rate + US ceiling from shipping.mjs, or doesNotShip when pickup-only. */
function shippingDetailsOf(item, currency = "USD") {
  if (!(item.shipLb > 0)) {
    return {
      "@type": "OfferShippingDetails",
      doesNotShip: true,
      shippingDestination: { "@type": "DefinedRegion", addressCountry: "US" },
    };
  }
  const wa = shippingCents([item.shipLb], { state: "WA", postalCode: "98402" });
  const ny = shippingCents([item.shipLb], { state: "NY", postalCode: "10001" });
  const ak = shippingCents([item.shipLb], { state: "AK", postalCode: "99501" });
  if (wa.error || ny.error || ak.error) return null;
  const usMax = Math.max(ny.cents, ak.cents);
  return [
    {
      "@type": "OfferShippingDetails",
      shippingRate: { "@type": "MonetaryAmount", value: (wa.cents / 100).toFixed(2), currency },
      shippingDestination: { "@type": "DefinedRegion", addressCountry: "US", addressRegion: "WA" },
      deliveryTime: { "@type": "ShippingDeliveryTime", handlingTime: days(1, 2), transitTime: days(1, 2) },
    },
    {
      "@type": "OfferShippingDetails",
      shippingRate: { "@type": "MonetaryAmount", value: (usMax / 100).toFixed(2), currency },
      shippingDestination: { "@type": "DefinedRegion", addressCountry: "US" },
      deliveryTime: { "@type": "ShippingDeliveryTime", handlingTime: days(1, 2), transitTime: days(2, 6) },
    },
  ];
}

function photoAlt(item, i) {
  const spec = specLine(item.description);
  return i === 0 && spec ? `${item.name} — ${spec}` : `${item.name}, photo ${i + 1}`;
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
  const dims = parseDimensions(item);
  const delivery = ["https://schema.org/OnSitePickup", ...(item.shipLb > 0 ? ["https://schema.org/ParcelService"] : [])];
  const crumbs = [
    { name: "Home", item: `${site}/` },
    { name: "Shop", item: `${site}/shop.html` },
    ...(item.category ? [{ name: item.category, item: `${site}/shop.html?type=${encodeURIComponent(item.category)}` }] : []),
    { name: item.name },
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
        material: materialOf(item),
        countryOfOrigin: "US",
        ...(dims.width ? { width: qvIn(dims.width) } : {}),
        ...(dims.height ? { height: qvIn(dims.height) } : {}),
        ...(item.shipLb > 0 ? { weight: { "@type": "QuantitativeValue", value: item.shipLb, unitCode: "LBR" } } : {}),
        creator: { "@type": "Person", "@id": `${site}/about.html#aaron`, name: "Aaron Filson" },
        brand: { "@type": "Brand", name: SITE_NAME },
        offers: item.variations.map((v) => {
          const shippingDetails = shippingDetailsOf(item, v.currency ?? "USD");
          return {
            "@type": "Offer",
            ...(many ? { name: v.name } : {}),
            url,
            price: (v.price / 100).toFixed(2),
            priceCurrency: v.currency ?? "USD",
            availability: isOpen(v) ? "https://schema.org/InStock" : "https://schema.org/SoldOut",
            itemCondition: "https://schema.org/NewCondition",
            availableDeliveryMethod: delivery,
            ...(shippingDetails ? { shippingDetails } : {}),
            seller: { "@type": "OnlineStore", "@id": `${site}/#store`, name: SITE_NAME, url: `${site}/` },
            // policies.html: returns are not accepted (a piece broken in shipping is refunded).
            hasMerchantReturnPolicy: {
              "@type": "MerchantReturnPolicy",
              applicableCountry: "US",
              returnPolicyCategory: "https://schema.org/MerchantReturnNotPermitted",
            },
          };
        }),
      },
      {
        "@type": "BreadcrumbList",
        "@id": `${url}#breadcrumb`,
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
    `<meta property="og:image:alt" content="${esc(photoAlt(item, 0))}">`,
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
            alt: photoAlt(item, i),
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
    `<nav class="crumbs" aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li><li><a href="/shop.html">Shop</a></li>` +
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
  const title = esc(pieceTitle(item));
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

/** Every listed piece (sold ones too: their pages stay up), with its 1200px photos for image search. */
export function piecesSitemap(items, site) {
  const urls = items.map((i) => {
    const loc = `<loc>${esc(`${site}/p/${i.id}`)}</loc>`;
    const lastmod = i.updatedAt ? `<lastmod>${esc(i.updatedAt.slice(0, 10))}</lastmod>` : "";
    const imgs = photosOf(i)
      .map((p) => `<image:image><image:loc>${esc(site + sized(p, 1200, "jpeg"))}</image:loc></image:image>`)
      .join("");
    return `  <url>${loc}${lastmod}${imgs}</url>`;
  });
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n` +
    `${urls.join("\n")}\n</urlset>\n`
  );
}

/** Atom 1.0 feed of pieces currently available in the shop (/p/feed.xml), for RSS readers and Pinterest. */
export function piecesFeed(items, site) {
  const open = items.filter((i) => i.variations.some(isOpen));
  const dates = open.filter((i) => i.updatedAt).map((i) => i.updatedAt);
  const updated = dates.sort().at(-1) ?? "2026-01-01T00:00:00Z";
  const entries = open.map((i) => {
    const url = `${site}/p/${i.id}`;
    const photo = photosOf(i)[0];
    const enclosure = photo ? `<link rel="enclosure" type="image/jpeg" href="${esc(site + sized(photo, 1200, "jpeg"))}"/>` : "";
    return (
      `  <entry>` +
      `<id>${esc(url)}</id>` +
      `<title>${esc(`${i.name} · ${priceText(i)}`)}</title>` +
      `<link href="${esc(url)}"/>` +
      enclosure +
      `<updated>${esc(i.updatedAt || updated)}</updated>` +
      `<summary>${esc(metaDescription(i))}</summary>` +
      `</entry>`
    );
  });
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<feed xmlns="http://www.w3.org/2005/Atom">\n` +
    `  <id>${esc(`${site}/p/feed.xml`)}</id>\n` +
    `  <title>${esc(`${SITE_NAME} — Available Pieces`)}</title>\n` +
    `  <link href="${esc(`${site}/shop.html`)}"/>\n` +
    `  <link href="${esc(`${site}/p/feed.xml`)}" rel="self" type="application/atom+xml"/>\n` +
    `  <updated>${esc(updated)}</updated>\n` +
    `  <author><name>Aaron Filson</name></author>\n` +
    `${entries.join("\n")}\n` +
    `</feed>\n`
  );
}
