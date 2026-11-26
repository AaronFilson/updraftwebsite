// Builds the deployable site into dist/:
//  - responsive AVIF + WebP variants of every photo in site/images (masters are never copied)
//  - stripped full-size JPEGs from site/images-full, linked from the lightbox only
//  - every image file name carries a content hash, so img/ and full/ can be cached forever
//  - gallery markup rendered into pages from site/data/*.json (no runtime fetch)
//  - shared header/footer partials and per-page head metadata (canonical, Open Graph, icons)
//  - JS/CSS bundled, minified and content-hashed; HTML minified, comments stripped
//  - the shell the API puts each piece's page in (piece-shell.html; backend/src/piece-page.mjs)
//  - icons, web manifest, robots.txt and (when SITE_URL is set) the sitemaps
import { readFile, writeFile, mkdir, rm, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import * as esbuild from "esbuild";
import { minify } from "html-minifier-terser";
import { currentStage } from "./stage.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "site");
const OUT = path.join(ROOT, "dist");
const CACHE = path.join(ROOT, ".cache", "images");
const WIDTHS = [400, 800, 1600];
const SITE_URL = (process.env.SITE_URL ?? "").replace(/\/$/, "");
// Per-stage settings (deploy/stages.json): public Square IDs for the browser, and whether search
// engines may index the stage. STAGE defaults to prod.
const STAGE = currentStage([]);
const INDEXABLE = STAGE.indexable;
const SITE_NAME = "Updraft Pottery Studio";
const BG = { light: "#f7f7f3", dark: "#141816" };

// Every page is in the menu, grouped under three dropdowns. Each is a <details>, so it opens by tap,
// click or keyboard even without JavaScript (menu.js adds closing on Escape or a click elsewhere).
/** @type {[string, [string, string][]][]} */
const NAV = [
  [
    "Work",
    [
      ["/#work", "Recent work"],
      ["/past-work.html", "Past work"],
    ],
  ],
  [
    "Studio",
    [
      ["/about.html", "About"],
      ["/kilns.html", "Kilns"],
      ["/terms.html", "Glossary of ceramic terms"],
    ],
  ],
  [
    "Shop",
    [
      ["/shop.html", "All pieces"],
      ["/care.html", "Care & use"],
      ["/policies.html", "Shipping, pickup & returns"],
    ],
  ],
];

const esc = (s = "") => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const jsonForScript = (data) => JSON.stringify(data).replace(/</g, "\\u003c");
const mb = (bytes) => (bytes / 1048576).toFixed(1) + " MB";
const hash = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 8);
const readData = async (file) => JSON.parse(await readFile(path.join(SRC, "data", file), "utf8"));
const SAME_AS = ["https://www.instagram.com/aaronmakespottery/", "https://www.facebook.com/AaronFilsonCeramics/"];

// Turns a gallery photo's title into a readable URL slug without cutting mid-word, so Google Images
// sees e.g. /img/archive/01-green-footed-bowl-800-HASH.webp instead of /img/archive/01-800-HASH.webp.
function slugify(s = "") {
  const words = s
    .toLowerCase()
    .replace(/['’"]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  let out = "";
  for (const w of words) {
    const next = out ? `${out}-${w}` : w;
    if (next.length > 44 && out) break;
    out = next;
  }
  return out;
}

async function imageSlugs() {
  const slugs = new Map();
  for (const file of ["work.json", "archive.json", "artist.json", "kiln-shed.json", "soda-kiln.json"]) {
    for (const e of await readData(file)) {
      if (e.image && e.title && !slugs.has(e.image)) slugs.set(e.image, slugify(e.title));
    }
  }
  return slugs;
}

// Writes buf into dist/<dir>/<name>-<hash><ext> and returns the site-relative URL.
async function emit(dir, name, ext, buf) {
  await mkdir(path.join(OUT, dir), { recursive: true });
  const file = `${name}-${hash(buf)}${ext}`;
  await writeFile(path.join(OUT, dir, file), buf);
  return `/${dir}/${file}`.replaceAll("\\", "/");
}

// Encoder settings by format and width.
const ENCODE = {
  webp: (w) => ({ quality: w <= 400 ? 70 : 76, effort: 6 }),
  avif: (w) => ({ quality: w <= 400 ? 48 : 52, effort: 4 }),
};

// Encodes each master once into .cache/images, then copies into dist, so rebuilds are fast. Cache
// files are named by a hash of everything that shapes the output (the photo's bytes, width, format,
// encoder settings, sharp/libvips versions), not by file times: a cache restored in CI (where every
// checkout looks new) is reused, and changing a quality setting re-encodes. Unused entries are pruned.
const ENGINE = `sharp ${sharp.versions.sharp} vips ${sharp.versions.vips}`;
async function images(slugs) {
  const meta = {};
  const used = new Set();
  await mkdir(CACHE, { recursive: true });
  for (const dir of await readdir(path.join(SRC, "images"))) {
    const srcDir = path.join(SRC, "images", dir);
    for (const file of (await readdir(srcDir)).filter((f) => /\.jpe?g$/i.test(f))) {
      const master = await readFile(path.join(srcDir, file));
      const masterHash = createHash("sha256").update(master).digest("hex");
      const rel = `images/${dir}/${file}`;
      const base = path.parse(file).name;
      const slug = slugs.get(rel);
      const stem = slug ? `${base}-${slug}` : base;
      const { width, height } = await sharp(master).metadata();
      const entry = { width, height, webp: {}, avif: {} };
      for (const w of WIDTHS.filter((w) => w <= width || w === WIDTHS[0])) {
        // AVIF is only used in the grid; the lightbox opens the 1600px WebP.
        for (const fmt of w < 1600 ? ["avif", "webp"] : ["webp"]) {
          const key = createHash("sha256")
            .update(JSON.stringify([masterHash, w, fmt, ENCODE[fmt](w), ENGINE]))
            .digest("hex")
            .slice(0, 32);
          const cached = path.join(CACHE, `${key}.${fmt}`);
          used.add(path.basename(cached));
          let buf = await readFile(cached).catch(() => null);
          if (!buf) {
            buf = await sharp(master).resize({ width: w, withoutEnlargement: true })[fmt](ENCODE[fmt](w)).toBuffer();
            await writeFile(cached, buf);
          }
          entry[fmt][w] = await emit(`img/${dir}`, `${stem}-${w}`, `.${fmt}`, buf);
        }
      }
      try {
        const buf = await readFile(path.join(SRC, "images-full", dir, file));
        entry.full = { url: await emit(`full/${dir}`, stem, path.extname(file), buf), size: buf.length };
      } catch {
        /* no full-size version for this image */
      }
      meta[rel] = entry;
    }
  }
  // Drop encodes no photo uses any more (and the old per-folder layout), so the cache doesn't grow forever.
  for (const e of await readdir(CACHE, { withFileTypes: true }))
    if (!used.has(e.name)) await rm(path.join(CACHE, e.name), { recursive: true, force: true });
  return meta;
}

// Justified-row tile: --r (aspect ratio) drives both the flex sizing and the image box,
// so every photo keeps its real proportions and each row has an even height.
// only: restrict the grid srcset to these widths (used to share exact files with the hero slideshow).
function figureHtml(entry, meta, eager, only) {
  const m = meta[entry.image];
  if (!m) throw new Error(`Missing image ${entry.image}`);
  const widths = Object.keys(m.webp).map(Number);
  const r = +(m.width / m.height).toFixed(3);
  // The 1600px size is only fetched when a visitor opens the lightbox.
  const srcset = (fmt) =>
    widths
      .filter((w) => w < 1600 && (!only || only.includes(w)))
      .map((w) => `${m[fmt][w]} ${w}w`)
      .join(", ");
  // Rendered tiles are about r x 240px on desktop and r x 130px on phones (rows stretch a little).
  const sizes = `(max-width:600px) ${Math.round(r * 140)}px, ${Math.round(r * 260)}px`;
  const alt = esc(entry.alt ?? entry.title);
  const full = m.full ? ` data-full="${m.full.url}" data-full-size="${mb(m.full.size)}"` : "";
  const desc = entry.description ? ` data-desc="${esc(entry.description)}"` : "";
  return `<figure class="tile" style="--r:${r}">
<a href="${m.webp[widths.at(-1)]}" class="zoom" data-alt="${alt}" data-title="${esc(entry.title)}"${desc}${full}>
<picture><source type="image/avif" srcset="${srcset("avif")}" sizes="${sizes}">
<img src="${m.webp[only?.[0] ?? 400] ?? m.webp[400]}" srcset="${srcset("webp")}" sizes="${sizes}"
 width="${m.width}" height="${m.height}" alt="${alt}"${eager === "high" ? ' fetchpriority="high"' : eager ? "" : ' loading="lazy"'} decoding="async"></picture></a>
<figcaption>${esc(entry.title)}</figcaption>
</figure>`;
}

// Galleries at the top of a page load their first rows eagerly (the largest visible photo may not be the first).
const EAGER_TILES = 6;
/**
 * @param {string} file
 * @param {Record<string, any>} meta
 * @param {{ eagerFirst?: boolean, only?: number[] }} [opts]
 */
async function gallery(file, meta, { eagerFirst = false, only = undefined } = {}) {
  const items = JSON.parse(await readFile(path.join(SRC, "data", file), "utf8"));
  return `<div class="gallery">${items.map((e, i) => figureHtml(e, meta, eagerFirst && (i === 0 ? "high" : i < EAGER_TILES), only)).join("\n")}</div>`;
}

// Hero slideshow of the artist photos, newest number first (09 -> 01). Only the first slide loads
// with the page; the script swaps data-srcset -> srcset one slide ahead of showing it.
// It and the About gallery both use only the 800px files (HERO_WIDTHS), so each photo downloads once.
const HERO_WIDTHS = [800];
async function heroShow(meta) {
  const entries = JSON.parse(await readFile(path.join(SRC, "data", "artist.json"), "utf8")).sort((a, b) =>
    b.image.localeCompare(a.image, undefined, { numeric: true }),
  );
  const sizes = "(min-width:700px) 46vw, 100vw";
  const slides = entries.map((e, i) => {
    const m = meta[e.image];
    if (!m) throw new Error(`Missing image ${e.image}`);
    const w = HERO_WIDTHS.find((x) => m.webp[x]) ?? 400;
    const set = (fmt) => `${m[fmt][w]} ${w}w`;
    const [ss, src] = i ? ["data-srcset", "data-src"] : ["srcset", "src"];
    // Portrait photos are shown whole over a blurred copy of themselves (the script reuses the
    // loaded image as the backdrop, so no extra file is fetched).
    const portrait = m.width < m.height;
    return `<figure class="slide${portrait ? " portrait" : ""}${i ? "" : " is-active"}"${i ? ' aria-hidden="true"' : ""}>
<picture><source type="image/avif" ${ss}="${set("avif")}" sizes="${sizes}">
<img ${src}="${m.webp[w]}" ${ss}="${set("webp")}" sizes="${sizes}" width="${m.width}" height="${m.height}" alt="${esc(e.alt ?? e.title)}"${i ? "" : ' fetchpriority="high"'} decoding="async"></picture>
<figcaption>${esc(e.title)}</figcaption>
</figure>`;
  });
  return `<div class="hero-show" role="group" aria-roledescription="slideshow" aria-label="Photos of the potter and the Pacific Northwest">
${slides.join("\n")}
<button class="hero-pause" type="button" aria-label="Pause slideshow" hidden><span aria-hidden="true"></span></button>
</div>`;
}

// One photo outside a gallery (no lightbox), lazy-loaded. only: the widths to offer; the maker photo
// uses the slideshow's 800px file so it downloads once.
function photo(meta, image, alt, { sizes, only = [400, 800] }) {
  const m = meta[image];
  if (!m) throw new Error(`Missing image ${image}`);
  const have = Object.keys(m.webp).map(Number);
  const ws = have.filter((w) => only.includes(w));
  if (!ws.length) ws.push(Math.min(...have));
  const set = (fmt) => ws.map((w) => `${m[fmt][w]} ${w}w`).join(", ");
  return `<picture><source type="image/avif" srcset="${set("avif")}" sizes="${sizes}">
<img src="${m.webp[ws[0]]}" srcset="${set("webp")}" sizes="${sizes}" width="${m.width}" height="${m.height}" alt="${esc(alt)}" loading="lazy" decoding="async"></picture>`;
}

async function makeOg(name, rel) {
  const buf = await sharp(path.join(SRC, rel)).resize(1200, 630, { fit: "cover" }).jpeg({ quality: 78, mozjpeg: true }).toBuffer();
  return emit("img", name, ".jpg", buf);
}

async function ogImages() {
  const [home, archive, about, kilns] = await Promise.all([
    makeOg("og", "images/work/08.jpg"),
    makeOg("og-archive", "images/archive/04.jpg"),
    makeOg("og-about", "images/artist/08.jpg"),
    makeOg("og-kilns", "images/soda-kiln/01.jpg"),
  ]);
  return {
    default: {
      url: home,
      alt: "Handmade stoneware and porcelain bowls, vases, plates and cups from Updraft Pottery Studio",
    },
    "past-work.html": {
      url: archive,
      alt: "Handmade green footed bowl beside a wide rust-red stoneware bowl by Aaron Filson",
    },
    "about.html": {
      url: about,
      alt: "Potter Aaron Filson on a Puget Sound beach at low tide",
    },
    "kilns.html": {
      url: kilns,
      alt: "Salt and soda kiln loaded with pottery behind its brick arch",
    },
  };
}

// Square PNG icons (Apple touch icon, manifest) from the SVG favicon on an opaque, padded background.
async function icons() {
  const svg = await readFile(path.join(SRC, "favicon.svg"), "utf8");
  const inner = svg.replace(/^<svg[^>]*>|<\/svg>\s*$/g, "");
  const padded = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="${BG.light}"/><g transform="translate(4 4) scale(.75)">${inner}</g></svg>`,
  );
  const png = (size) =>
    sharp(padded, { density: (72 * size) / 32 })
      .resize(size, size)
      .png()
      .toBuffer();
  const [apple, i192, i512] = await Promise.all([180, 192, 512].map(async (s) => emit("img", `icon-${s}`, ".png", await png(s))));
  await writeFile(path.join(OUT, "favicon.svg"), svg);
  await writeFile(
    path.join(OUT, "site.webmanifest"),
    JSON.stringify({
      name: SITE_NAME,
      short_name: "Updraft",
      start_url: "/",
      display: "browser",
      background_color: BG.light,
      theme_color: BG.light,
      icons: [
        { src: i192, sizes: "192x192", type: "image/png" },
        { src: i512, sizes: "512x512", type: "image/png" },
      ],
    }),
  );
  return { apple, icon512: i512 };
}

async function bundle() {
  const result = await esbuild.build({
    entryPoints: {
      site: path.join(SRC, "js", "site.js"),
      shop: path.join(SRC, "js", "shop.js"),
      style: path.join(SRC, "css", "style.css"),
    },
    outdir: path.join(OUT, "assets"),
    bundle: true,
    splitting: true,
    format: "esm",
    minify: true,
    legalComments: "none",
    target: ["es2022", "safari16"],
    entryNames: "[name]-[hash]",
    loader: { ".woff2": "file" }, // fonts become assets/NAME-HASH.woff2, cached for a year
    publicPath: "/assets/", // the CSS is inlined into each page, so its font URLs must be absolute
    chunkNames: "[name]-[hash]",
    metafile: true,
    // site/js/config.js reads these; only public values (the Square token never reaches the browser).
    define: {
      __SITE_CONFIG__: JSON.stringify({
        squareEnv: STAGE.squareEnv,
        squareAppId: STAGE.squareAppId,
        squareLocationId: STAGE.squareLocationId,
      }),
    },
  });
  const names = {};
  for (const [out, info] of Object.entries(result.metafile.outputs)) {
    if (info.entryPoint) names[path.parse(info.entryPoint).name] = "assets/" + path.basename(out);
    if (out.endsWith(".woff2")) names.font = "assets/" + path.basename(out);
  }
  return names;
}

function nav(current) {
  const menus = NAV.map(([label, links]) => {
    const items = links.filter(([href]) => href !== "/policies.html" || email); // that page is only built with an email set
    const here = items.some(([href]) => href === current);
    const li = items.map(([href, text]) => `<li><a href="${href}"${href === current ? ' aria-current="page"' : ""}>${esc(text)}</a></li>`);
    return `<details class="menu${here ? " is-current" : ""}"><summary>${label}</summary><ul>${li.join("")}</ul></details>`;
  });
  return `${menus.join("")}<a class="cart-link" href="/shop.html#cart">Cart <span class="badge" data-cart-count data-n="0">0</span><span class="vh"> items</span></a>`;
}

const SHELL = "piece-shell.html";
const pageUrl = (name) => SITE_URL + (name === "index.html" ? "/" : `/${name}`);
const largestWebp = (m) => m.webp[Math.max(...Object.keys(m.webp).map(Number))];

// Breadcrumb trails for every subpage (visual HTML + matching BreadcrumbList JSON-LD).
/** @type {Record<string, [string, string?][]>} */
const CRUMBS = {
  "shop.html": [["Home", "/"], ["Shop"]],
  "past-work.html": [["Home", "/"], ["Past work"]],
  "about.html": [["Home", "/"], ["About the studio"]],
  "kilns.html": [["Home", "/"], ["Kiln projects"]],
  "terms.html": [["Home", "/"], ["Ceramic terms"]],
  "care.html": [["Home", "/"], ["Shop", "/shop.html"], ["Care & use"]],
  "policies.html": [["Home", "/"], ["Shop", "/shop.html"], ["Shipping, pickup & returns"]],
};

function crumbsHtml(name) {
  const trail = CRUMBS[name];
  if (!trail) return "";
  const li = trail.map(([label, href]) =>
    href ? `<li><a href="${href}">${esc(label)}</a></li>` : `<li><span aria-current="page">${esc(label)}</span></li>`,
  );
  return `<nav class="crumbs" aria-label="Breadcrumb"><ol>${li.join("")}</ol></nav>`;
}

function crumbsSchema(name) {
  const trail = CRUMBS[name];
  if (!trail) return null;
  return {
    "@type": "BreadcrumbList",
    "@id": `${pageUrl(name)}#breadcrumb`,
    itemListElement: trail.map(([label, href], i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: label,
      ...(href ? { item: SITE_URL + href } : {}),
    })),
  };
}

// Renders the ceramic glossary (site/data/terms.json) into both HTML (<dl>) and DefinedTermSet JSON-LD,
// so definitions live in one place with no HTML tag stripping.
function termsHtml(terms) {
  const items = terms.map((t) => {
    const more = t.link ? ` ${esc(t.link.before)}<a href="${esc(t.link.href)}">${esc(t.link.text)}</a>${esc(t.link.after)}` : "";
    return `<dt id="${esc(t.id)}">${esc(t.term)}</dt><dd>${esc(t.definition)}${more}</dd>`;
  });
  return `<dl class="terms">${items.join("\n")}</dl>`;
}

function termsSchema(terms, url) {
  return terms.map((t) => ({
    "@type": "DefinedTerm",
    "@id": `${url}#${t.id}`,
    url: `${url}#${t.id}`,
    name: t.term,
    description: t.link ? `${t.definition} ${t.link.before}${t.link.text}${t.link.after}` : t.definition,
    inDefinedTermSet: url,
  }));
}

// Structured data (@graph) per static page. Piece pages get Product + BreadcrumbList from backend/src/piece-page.mjs.
function pageSchema(name, html, { ogs, icon512, email, meta, archive, terms }) {
  if (name === SHELL || name === "error.html" || /<meta name="robots" content="noindex"/.test(html)) return null;
  const url = pageUrl(name);
  const storeId = `${SITE_URL}/#store`;
  const websiteId = `${SITE_URL}/#website`;
  const personId = `${SITE_URL}/about.html#aaron`;
  const title = (html.match(/<title>(.*?)<\/title>/)?.[1] ?? SITE_NAME).replaceAll("&amp;", "&");
  const desc = (html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "").replaceAll("&amp;", "&");

  if (name === "index.html") {
    return {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "OnlineStore",
          "@id": storeId,
          name: SITE_NAME,
          description: desc,
          url: `${SITE_URL}/`,
          logo: SITE_URL + icon512,
          image: SITE_URL + ogs.default.url,
          ...(email ? { email } : {}),
          founder: { "@type": "Person", "@id": personId, name: "Aaron Filson", url: pageUrl("about.html") },
          address: { "@type": "PostalAddress", addressLocality: "Tacoma", addressRegion: "WA", addressCountry: "US" },
          areaServed: { "@type": "Country", name: "US" },
          sameAs: SAME_AS,
          hasMerchantReturnPolicy: {
            "@type": "MerchantReturnPolicy",
            "@id": `${SITE_URL}/policies.html#returns`,
            applicableCountry: "US",
            returnPolicyCategory: "https://schema.org/MerchantReturnNotPermitted",
          },
        },
        {
          "@type": "WebSite",
          "@id": websiteId,
          name: SITE_NAME,
          url: `${SITE_URL}/`,
          publisher: { "@id": storeId },
        },
      ],
    };
  }

  let primary;
  if (name === "about.html") {
    primary = {
      "@type": "ProfilePage",
      "@id": `${url}#webpage`,
      url,
      name: title,
      description: desc,
      isPartOf: { "@id": websiteId },
      mainEntity: {
        "@type": "Person",
        "@id": personId,
        name: "Aaron Filson",
        jobTitle: "Potter and Ceramic Artist",
        description: "Tacoma potter making wheel-thrown porcelain, stoneware, and soda-fired ceramics at Updraft Pottery Studio.",
        url,
        image: SITE_URL + meta["images/artist/08.jpg"].webp[800],
        homeLocation: { "@type": "Place", name: "Tacoma, WA" },
        worksFor: { "@type": "OnlineStore", "@id": storeId, name: SITE_NAME },
        alumniOf: [
          { "@type": "CollegeOrUniversity", name: "University of Puget Sound" },
          { "@type": "CollegeOrUniversity", name: "Green River College" },
        ],
        sameAs: SAME_AS,
      },
    };
  } else if (name === "past-work.html") {
    primary = {
      "@type": "CollectionPage",
      "@id": `${url}#webpage`,
      url,
      name: title,
      description: desc,
      isPartOf: { "@id": websiteId },
      creator: { "@id": personId },
      mainEntity: {
        "@type": "ItemList",
        numberOfItems: archive.length,
        itemListElement: archive.map((e, i) => ({
          "@type": "ListItem",
          position: i + 1,
          item: {
            "@type": "VisualArtwork",
            name: e.title,
            ...(e.description ? { description: e.description } : {}),
            artform: "Pottery",
            image: SITE_URL + largestWebp(meta[e.image]),
            creator: { "@type": "Person", "@id": personId, name: "Aaron Filson" },
          },
        })),
      },
    };
  } else if (name === "kilns.html") {
    primary = {
      "@type": "CollectionPage",
      "@id": `${url}#webpage`,
      url,
      name: title,
      description: desc,
      isPartOf: { "@id": websiteId },
      hasPart: [
        {
          "@type": "Article",
          "@id": `${url}#kiln-shed`,
          url: `${url}#kiln-shed`,
          headline: "The updraft kiln shed",
          description: "Housing the propane updraft kiln at Updraft Pottery Studio in Tacoma, Washington.",
          image: SITE_URL + largestWebp(meta["images/kiln-shed/01.jpg"]),
          author: { "@type": "Person", "@id": personId, name: "Aaron Filson" },
          publisher: { "@type": "OnlineStore", "@id": storeId, name: SITE_NAME },
        },
        {
          "@type": "Article",
          "@id": `${url}#soda-kiln`,
          url: `${url}#soda-kiln`,
          headline: "The soda kiln",
          description: "Building and firing a salt and soda kiln at Elinor Maroney's studio in Covington, Washington.",
          image: SITE_URL + largestWebp(meta["images/soda-kiln/01.jpg"]),
          author: { "@type": "Person", "@id": personId, name: "Aaron Filson" },
          publisher: { "@type": "OnlineStore", "@id": storeId, name: SITE_NAME },
        },
      ],
    };
  } else if (name === "terms.html") {
    primary = {
      "@type": "DefinedTermSet",
      "@id": `${url}#glossary`,
      url,
      name: "Pottery and Ceramic Glaze Glossary",
      description: desc,
      isPartOf: { "@id": websiteId },
      hasDefinedTerm: termsSchema(terms, url),
    };
  } else if (name === "shop.html") {
    primary = {
      "@type": "CollectionPage",
      "@id": `${url}#webpage`,
      url,
      name: title,
      description: desc,
      isPartOf: { "@id": websiteId },
      about: { "@id": storeId },
    };
  } else {
    primary = {
      "@type": "WebPage",
      "@id": `${url}#webpage`,
      url,
      name: title,
      description: desc,
      isPartOf: { "@id": websiteId },
    };
  }
  const crumbs = crumbsSchema(name);
  return { "@context": "https://schema.org", "@graph": crumbs ? [primary, crumbs] : [primary] };
}

// Head tags shared by every page; title and description are read from the page itself.
function headMeta(name, html, shared) {
  const { ogs, apple } = shared;
  const og = ogs[name] ?? ogs.default;
  const title = html.match(/<title>(.*?)<\/title>/)?.[1] ?? SITE_NAME;
  const desc = html.match(/<meta name="description" content="([^"]*)"/)?.[1];
  const tags = [
    `<link rel="icon" href="/favicon.svg" type="image/svg+xml">`,
    `<link rel="apple-touch-icon" href="${apple}">`,
    `<link rel="manifest" href="/site.webmanifest">`,
    `<meta name="theme-color" content="${BG.light}" media="(prefers-color-scheme: light)">`,
    `<meta name="theme-color" content="${BG.dark}" media="(prefers-color-scheme: dark)">`,
  ];
  if (!INDEXABLE) tags.push(`<meta name="robots" content="noindex">`);
  // The piece shell gets its address and preview from the API, per piece (backend/src/piece-page.mjs).
  if (INDEXABLE && name !== SHELL && !/<meta name="robots" content="noindex"/.test(html)) {
    tags.push(
      `<link rel="canonical" href="${pageUrl(name)}">`,
      `<meta property="og:site_name" content="${SITE_NAME}">`,
      `<meta property="og:type" content="website">`,
      `<meta property="og:title" content="${title}">`,
      ...(desc ? [`<meta property="og:description" content="${desc}">`] : []),
      `<meta property="og:url" content="${pageUrl(name)}">`,
      `<meta property="og:image" content="${SITE_URL}${og.url}">`,
      `<meta property="og:image:width" content="1200">`,
      `<meta property="og:image:height" content="630">`,
      `<meta property="og:image:alt" content="${esc(og.alt)}">`,
      `<meta name="twitter:card" content="summary_large_image">`,
    );
  }
  const schema = pageSchema(name, html, shared);
  if (schema) tags.push(`<script type="application/ld+json">${jsonForScript(schema)}</script>`);
  return tags.map((t) => "  " + t).join("\n");
}

async function page(name, replacements, shared) {
  let html = await readFile(path.join(SRC, name), "utf8");
  html = html.replace("<!--meta-->", headMeta(name, html, shared));
  html = html.replace("<!--crumbs-->", crumbsHtml(name));
  for (const [k, v] of Object.entries(replacements)) html = html.replaceAll(k, v);
  const leftover = html.match(/\{\{\w+\}\}|<!--\w+-->/);
  if (leftover) throw new Error(`${name}: unreplaced placeholder ${leftover[0]}`);
  const out = await minify(html, {
    collapseWhitespace: true,
    removeComments: true,
    removeRedundantAttributes: true,
    sortAttributes: true,
    sortClassName: true,
    useShortDoctype: true,
    minifyCSS: true,
    // The only inline script is JSON-LD; the minifier also passes fragments here, so leave anything unparseable alone.
    minifyJS: (text) => {
      try {
        return JSON.stringify(JSON.parse(text));
      } catch {
        return text;
      }
    },
  });
  await writeFile(path.join(OUT, name), out);
  return out.length;
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const [slugs, workData, archiveData, artistData, kilnShedData, sodaKilnData, termsData] = await Promise.all([
  imageSlugs(),
  readData("work.json"),
  readData("archive.json"),
  readData("artist.json"),
  readData("kiln-shed.json"),
  readData("soda-kiln.json"),
  readData("terms.json"),
]);
const meta = await images(slugs);
const ogs = await ogImages();
const { apple, icon512 } = await icons();
const assets = await bundle();
const css = await readFile(path.join(OUT, assets.style), "utf8");
await rm(path.join(OUT, assets.style)); // inlined into every page instead
const [header, footer, signup] = await Promise.all(
  ["header.html", "footer.html", "signup.html"].map((f) => readFile(path.join(SRC, "partials", f), "utf8")),
);

// Optional site-wide announcement banner from site/data/site.json:
//   { "text": "...", "linkText": "...", "href": "https://... or /...", "until": "2026-10-24T16:00:00-07:00" }
// Omitted at build time once `until` has passed; site/js/banner.js also removes it if `until` passes between publishes.
function renderBanner(b, now = Date.now()) {
  if (!b || !b.text?.trim()) return "";
  let untilAttr = "";
  if (b.until) {
    const until = Date.parse(b.until);
    if (Number.isNaN(until)) throw new Error(`site.json banner.until looks wrong: ${b.until}`);
    if (now >= until) return "";
    untilAttr = ` data-until="${esc(b.until)}"`;
  }
  const href = b.href?.trim() ?? "";
  const linkText = b.linkText?.trim() ?? "";
  if (Boolean(href) !== Boolean(linkText)) throw new Error("site.json banner needs both linkText and href, or neither");
  if (href && !/^(https?:\/\/|\/)/.test(href)) throw new Error(`site.json banner.href must start with https://, http://, or /: ${href}`);
  const link = href ? ` <a href="${esc(href)}">${esc(linkText)}</a>` : "";
  return `  <div class="sale-banner" role="region" aria-label="Announcement"${untilAttr}><p>${esc(b.text.trim())}${link}</p></div>\n`;
}

// Site-wide settings. The policy page (and links to it) is only built once a contact email is set,
// so a half-finished page can't be published.
const siteData = await readData("site.json");
const email = siteData.contactEmail?.trim() ?? "";
if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error(`site.json contactEmail looks wrong: ${email}`);
const mailto = email ? `<a href="mailto:${esc(email)}">${esc(email)}</a>` : "";
const bannerHtml = renderBanner(siteData.banner);

const common = (current, js = assets.site) => ({
  "<!--header-->": header.replace("{{banner}}", bannerHtml).replace("{{nav}}", nav(current)),
  "<!--footer-->": footer,
  // ~4KB gzipped: inlining saves a render-blocking request on every page.
  // Fetch the heading font alongside the page instead of after the CSS is read, so the headline swaps less.
  "{{css}}": `<link rel="preload" href="/${assets.font}" as="font" type="font/woff2" crossorigin><style>${css}</style>`,
  "{{js}}": "/" + js,
  "{{year}}": String(new Date().getFullYear()),
  "{{og}}": SITE_URL + ogs.default.url,
  "{{root}}": SITE_URL + "/",
  "{{policiesItem}}": email ? '<li><a href="/policies.html">Shipping &amp; returns</a></li>' : "",
  "{{contactLine}}": email ? `<br>${mailto}` : "",
  "{{pickupEmail}}": email ? `by email at ${mailto}` : "by email",
  "{{policiesShopLink}}": email ? '<a href="/policies.html">Shipping, pickup &amp; returns</a>' : "",
  "{{contactEmail}}": esc(email),
  "{{signup}}": signup, // in the footer; the home page places it mid-page instead
});
const shared = { ogs, apple, icon512, email, meta, archive: archiveData, terms: termsData };

const sizes = {
  "index.html": await page(
    "index.html",
    {
      ...common(""),
      "{{signup}}": "",
      "<!--signup-->": signup,
      "<!--hero-show-->": await heroShow(meta),
      "<!--work-->": await gallery("work.json", meta), // below the fold now; the slideshow photo is the priority
      "<!--maker-photo-->": photo(meta, "images/artist/08.jpg", "Aaron Filson on a Puget Sound beach at low tide", {
        sizes: "(min-width:760px) 520px, 100vw",
        only: HERO_WIDTHS,
      }),
      "<!--kiln-photo-->": photo(meta, "images/soda-kiln/01.jpg", "The soda kiln at Elinor Maroney's studio in Covington", {
        sizes: "(min-width:760px) 520px, 100vw",
      }),
    },
    shared,
  ),
  "about.html": await page(
    "about.html",
    {
      ...common("/about.html"),
      "<!--artist-->": await gallery("artist.json", meta, { only: HERO_WIDTHS }), // same files as the home slideshow
    },
    shared,
  ),
  "past-work.html": await page(
    "past-work.html",
    {
      ...common("/past-work.html"),
      "<!--archive-->": await gallery("archive.json", meta, { eagerFirst: true }),
    },
    shared,
  ),
  "kilns.html": await page(
    "kilns.html",
    {
      ...common("/kilns.html"),
      "<!--kiln-shed-->": await gallery("kiln-shed.json", meta, { eagerFirst: true }),
      "<!--soda-kiln-->": await gallery("soda-kiln.json", meta),
    },
    shared,
  ),
  "terms.html": await page("terms.html", { ...common("/terms.html"), "<!--terms-->": termsHtml(termsData) }, shared),
  "care.html": await page("care.html", common("/care.html"), shared),
  ...(email ? { "policies.html": await page("policies.html", common("/policies.html"), shared) } : {}),
  "shop.html": await page("shop.html", common("/shop.html", assets.shop), shared),
  "error.html": await page("error.html", common(""), shared),
  [SHELL]: await page(SHELL, common(""), shared),
};

// High-res image URLs per static page for sitemap-pages.xml, so Google Images discovers the 1600px
// gallery photos that otherwise sit behind lightbox links (<a href>) rather than <img src>.
const heroWebp = (img) => meta[img].webp[HERO_WIDTHS.find((w) => meta[img].webp[w]) ?? 400];
const pageImages = {
  "index.html": [
    ...new Set([
      ...workData.map((e) => largestWebp(meta[e.image])),
      ...artistData.map((e) => heroWebp(e.image)),
      meta["images/soda-kiln/01.jpg"].webp[800] ?? largestWebp(meta["images/soda-kiln/01.jpg"]),
    ]),
  ],
  "about.html": artistData.map((e) => heroWebp(e.image)),
  "past-work.html": archiveData.map((e) => largestWebp(meta[e.image])),
  "kilns.html": [...kilnShedData, ...sodaKilnData].map((e) => largestWebp(meta[e.image])),
};

const indexable = Object.keys(sizes).filter((n) => n !== "error.html" && n !== SHELL);
await writeFile(
  path.join(OUT, "robots.txt"),
  INDEXABLE
    ? `User-agent: *\nAllow: /\nDisallow: /${SHELL}\n${SITE_URL ? `Sitemap: ${SITE_URL}/sitemap.xml\n` : ""}`
    : "User-agent: *\nDisallow: /\n",
); // staging stays out of search results
// sitemap.xml names two: this build's pages (with their high-res gallery photos), and every piece's
// page, which the API lists from Square (/p/sitemap.xml, backend/src/piece.mjs).
if (SITE_URL && INDEXABLE) {
  const urlEntries = indexable.map((n) => {
    const imgs = (pageImages[n] ?? []).map((u) => `\n    <image:image><image:loc>${esc(SITE_URL + u)}</image:loc></image:image>`).join("");
    return imgs ? `  <url>\n    <loc>${esc(pageUrl(n))}</loc>${imgs}\n  </url>` : `  <url><loc>${esc(pageUrl(n))}</loc></url>`;
  });
  await writeFile(
    path.join(OUT, "sitemap-pages.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${urlEntries.join("\n")}
</urlset>
`,
  );
  await writeFile(
    path.join(OUT, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${SITE_URL}/sitemap-pages.xml</loc></sitemap>
  <sitemap><loc>${SITE_URL}/p/sitemap.xml</loc></sitemap>
</sitemapindex>
`,
  );
}

console.log(
  "Built dist/",
  Object.entries(sizes)
    .map(([k, v]) => `${k} ${(v / 1024).toFixed(1)}KB`)
    .join(", "),
);
if (!SITE_URL)
  console.warn(
    "SITE_URL not set: canonical/og URLs are relative and no sitemap.xml was written. Use SITE_URL=https://yourdomain npm run build before deploying.",
  );
