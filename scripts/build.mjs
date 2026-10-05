// Builds the deployable site into dist/:
//  - responsive AVIF + WebP variants of every photo in site/images (masters are never copied)
//  - stripped full-size JPEGs from site/images-full, linked from the lightbox only
//  - every image file name carries a content hash, so img/ and full/ can be cached forever
//  - gallery markup rendered into pages from site/data/*.json (no runtime fetch)
//  - shared header/footer partials and per-page head metadata (canonical, Open Graph, icons)
//  - JS/CSS bundled, minified and content-hashed; HTML minified, comments stripped
//  - icons, web manifest, robots.txt and (when SITE_URL is set) sitemap.xml
import { readFile, writeFile, mkdir, rm, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import * as esbuild from "esbuild";
import { minify } from "html-minifier-terser";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "site");
const OUT = path.join(ROOT, "dist");
const CACHE = path.join(ROOT, ".cache", "images");
const WIDTHS = [400, 800, 1600];
const SITE_URL = (process.env.SITE_URL ?? "").replace(/\/$/, "");
const SITE_NAME = "Updraft Pottery Studio";
const BG = { light: "#f6f1ea", dark: "#1b1714" };

const NAV = [
  ["/#work", "Work"],
  ["/past-work.html", "Past work"],
  ["/kilns.html", "Kilns"],
  // Full label where the nav has room (>= 720px, measured), short one on phones.
  ["/terms.html", '<span class="nav-long">Ceramic Terms</span><span class="nav-short">Glossary</span>'],
  ["/#about", "About"],
  ["/shop.html", "Shop"],
];

const esc = (s = "") => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const mb = (bytes) => (bytes / 1048576).toFixed(1) + " MB";
const hash = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 8);

async function newer(src, out) {
  try { return (await stat(out)).mtimeMs >= (await stat(src)).mtimeMs; } catch { return false; }
}

// Writes buf into dist/<dir>/<name>-<hash><ext> and returns the site-relative URL.
async function emit(dir, name, ext, buf) {
  await mkdir(path.join(OUT, dir), { recursive: true });
  const file = `${name}-${hash(buf)}${ext}`;
  await writeFile(path.join(OUT, dir, file), buf);
  return `/${dir}/${file}`.replaceAll("\\", "/");
}

const ENCODERS = {
  webp: (img, w) => img.webp({ quality: w <= 400 ? 70 : 76, effort: 6 }),
  avif: (img, w) => img.avif({ quality: w <= 400 ? 48 : 52, effort: 4 }),
};

// Encodes each master once into .cache, then copies into dist, so rebuilds are fast.
async function images() {
  const meta = {};
  for (const dir of await readdir(path.join(SRC, "images"))) {
    const srcDir = path.join(SRC, "images", dir);
    await mkdir(path.join(CACHE, dir), { recursive: true });
    for (const file of (await readdir(srcDir)).filter((f) => /\.jpe?g$/i.test(f))) {
      const src = path.join(srcDir, file);
      const base = path.parse(file).name;
      const { width, height } = await sharp(src).metadata();
      const entry = { width, height, webp: {}, avif: {} };
      for (const w of WIDTHS.filter((w) => w <= width || w === WIDTHS[0])) {
        // AVIF is only used in the grid; the lightbox opens the 1600px WebP.
        for (const fmt of w < 1600 ? ["avif", "webp"] : ["webp"]) {
          const cached = path.join(CACHE, dir, `${base}-${w}.${fmt}`);
          if (!(await newer(src, cached))) {
            await ENCODERS[fmt](sharp(src).resize({ width: w, withoutEnlargement: true }), w).toFile(cached);
          }
          entry[fmt][w] = await emit(`img/${dir}`, `${base}-${w}`, `.${fmt}`, await readFile(cached));
        }
      }
      try {
        const buf = await readFile(path.join(SRC, "images-full", dir, file));
        entry.full = { url: await emit(`full/${dir}`, base, path.extname(file), buf), size: buf.length };
      } catch { /* no full-size version for this image */ }
      meta[`images/${dir}/${file}`] = entry;
    }
  }
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
  const srcset = (fmt) => widths.filter((w) => w < 1600 && (!only || only.includes(w))).map((w) => `${m[fmt][w]} ${w}w`).join(", ");
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
async function gallery(file, meta, { eagerFirst = false, only } = {}) {
  const items = JSON.parse(await readFile(path.join(SRC, "data", file), "utf8"));
  return `<div class="gallery">${items.map((e, i) => figureHtml(e, meta, eagerFirst && (i === 0 ? "high" : i < EAGER_TILES), only)).join("\n")}</div>`;
}

// Hero slideshow of the artist photos, newest number first (09 -> 01). Only the first slide loads
// with the page; the script swaps data-srcset -> srcset one slide ahead of showing it.
// It and the About gallery both use only the 800px files (HERO_WIDTHS), so each photo downloads once.
const HERO_WIDTHS = [800];
async function heroShow(meta) {
  const entries = JSON.parse(await readFile(path.join(SRC, "data", "artist.json"), "utf8"))
    .sort((a, b) => b.image.localeCompare(a.image, undefined, { numeric: true }));
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

async function ogImage() {
  const src = path.join(SRC, "images", "work", "08.jpg");
  const buf = await sharp(src).resize(1200, 630, { fit: "cover" }).jpeg({ quality: 78, mozjpeg: true }).toBuffer();
  return emit("img", "og", ".jpg", buf);
}

// Square PNG icons (Apple touch icon, manifest) from the SVG favicon on an opaque, padded background.
async function icons() {
  const svg = await readFile(path.join(SRC, "favicon.svg"), "utf8");
  const inner = svg.replace(/^<svg[^>]*>|<\/svg>\s*$/g, "");
  const padded = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="${BG.light}"/><g transform="translate(4 4) scale(.75)">${inner}</g></svg>`);
  const png = (size) => sharp(padded, { density: (72 * size) / 32 }).resize(size, size).png().toBuffer();
  const [apple, i192, i512] = await Promise.all([180, 192, 512].map(async (s) => emit("img", `icon-${s}`, ".png", await png(s))));
  await writeFile(path.join(OUT, "favicon.svg"), svg);
  await writeFile(path.join(OUT, "site.webmanifest"), JSON.stringify({
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
  }));
  return { apple };
}

async function bundle() {
  const result = await esbuild.build({
    entryPoints: { site: path.join(SRC, "js", "site.js"), shop: path.join(SRC, "js", "shop.js"), style: path.join(SRC, "css", "style.css") },
    outdir: path.join(OUT, "assets"),
    bundle: true,
    splitting: true,
    format: "esm",
    minify: true,
    legalComments: "none",
    target: ["es2022", "safari16"],
    entryNames: "[name]-[hash]",
    chunkNames: "[name]-[hash]",
    metafile: true,
  });
  const names = {};
  for (const [out, info] of Object.entries(result.metafile.outputs)) {
    if (info.entryPoint) names[path.parse(info.entryPoint).name] = "assets/" + path.basename(out);
  }
  return names;
}

function nav(current) {
  const links = NAV.map(([href, label]) => `<a href="${href}"${href === current ? ' aria-current="page"' : ""}>${label}</a>`).join("");
  return `${links}<a class="cart-link" href="/shop.html#cart">Cart <span class="badge" data-cart-count data-n="0">0</span><span class="vh"> items</span></a>`;
}

const pageUrl = (name) => SITE_URL + (name === "index.html" ? "/" : `/${name}`);

// Head tags shared by every page; title and description are read from the page itself.
function headMeta(name, html, { og, apple }) {
  const title = html.match(/<title>(.*?)<\/title>/)?.[1] ?? SITE_NAME;
  const desc = html.match(/<meta name="description" content="([^"]*)"/)?.[1];
  const tags = [
    `<link rel="icon" href="/favicon.svg" type="image/svg+xml">`,
    `<link rel="apple-touch-icon" href="${apple}">`,
    `<link rel="manifest" href="/site.webmanifest">`,
    `<meta name="theme-color" content="${BG.light}" media="(prefers-color-scheme: light)">`,
    `<meta name="theme-color" content="${BG.dark}" media="(prefers-color-scheme: dark)">`,
  ];
  if (!/<meta name="robots" content="noindex"/.test(html)) {
    tags.push(
      `<link rel="canonical" href="${pageUrl(name)}">`,
      `<meta property="og:site_name" content="${SITE_NAME}">`,
      `<meta property="og:type" content="website">`,
      `<meta property="og:title" content="${title}">`,
      ...(desc ? [`<meta property="og:description" content="${desc}">`] : []),
      `<meta property="og:url" content="${pageUrl(name)}">`,
      `<meta property="og:image" content="${SITE_URL}${og}">`,
      `<meta property="og:image:width" content="1200">`,
      `<meta property="og:image:height" content="630">`,
      `<meta name="twitter:card" content="summary_large_image">`,
    );
  }
  return tags.map((t) => "  " + t).join("\n");
}

async function page(name, replacements, shared) {
  let html = await readFile(path.join(SRC, name), "utf8");
  html = html.replace("<!--meta-->", headMeta(name, html, shared));
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
    minifyJS: (text) => { try { return JSON.stringify(JSON.parse(text)); } catch { return text; } },
  });
  await writeFile(path.join(OUT, name), out);
  return out.length;
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const meta = await images();
const og = await ogImage();
const { apple } = await icons();
const assets = await bundle();
const css = await readFile(path.join(OUT, assets.style), "utf8");
await rm(path.join(OUT, assets.style)); // inlined into every page instead
const [header, footer, signup] = await Promise.all(["header.html", "footer.html", "signup.html"].map((f) => readFile(path.join(SRC, "partials", f), "utf8")));

const common = (current, js = assets.site) => ({
  "<!--header-->": header.replace("{{nav}}", nav(current)),
  "<!--footer-->": footer,
  // ~4KB gzipped: inlining saves a render-blocking request on every page.
  "{{css}}": `<style>${css}</style>`,
  "{{js}}": "/" + js,
  "{{year}}": String(new Date().getFullYear()),
  "{{og}}": SITE_URL + og,
  "{{root}}": SITE_URL + "/",
  "{{signup}}": signup, // in the footer; the home page places it mid-page instead
});
const shared = { og, apple };

const sizes = {
  "index.html": await page("index.html", {
    ...common(""),
    "{{signup}}": "",
    "<!--signup-->": signup,
    "<!--hero-show-->": await heroShow(meta),
    "<!--work-->": await gallery("work.json", meta), // below the fold now; the slideshow photo is the priority
    "<!--artist-->": await gallery("artist.json", meta, { only: HERO_WIDTHS }),
  }, shared),
  "past-work.html": await page("past-work.html", {
    ...common("/past-work.html"),
    "<!--archive-->": await gallery("archive.json", meta, { eagerFirst: true }),
  }, shared),
  "kilns.html": await page("kilns.html", {
    ...common("/kilns.html"),
    "<!--kiln-shed-->": await gallery("kiln-shed.json", meta, { eagerFirst: true }),
    "<!--soda-kiln-->": await gallery("soda-kiln.json", meta),
  }, shared),
  "terms.html": await page("terms.html", common("/terms.html"), shared),
  "shop.html": await page("shop.html", common("/shop.html", assets.shop), shared),
  "error.html": await page("error.html", common(""), shared),
};

const indexable = Object.keys(sizes).filter((n) => n !== "error.html");
await writeFile(path.join(OUT, "robots.txt"), `User-agent: *\nAllow: /\n${SITE_URL ? `Sitemap: ${SITE_URL}/sitemap.xml\n` : ""}`);
if (SITE_URL) {
  await writeFile(path.join(OUT, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${indexable.map((n) => `  <url><loc>${pageUrl(n)}</loc></url>`).join("\n")}
</urlset>
`);
}

console.log("Built dist/", Object.entries(sizes).map(([k, v]) => `${k} ${(v / 1024).toFixed(1)}KB`).join(", "));
if (!SITE_URL) console.warn("SITE_URL not set: canonical/og URLs are relative and no sitemap.xml was written. Use SITE_URL=https://yourdomain npm run build before deploying.");
