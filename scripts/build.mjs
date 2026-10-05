// Builds the deployable site into dist/:
//  - responsive WebP variants of every photo in site/images (masters are never copied)
//  - stripped full-size JPEGs from site/images-full, linked from the lightbox only
//  - gallery markup rendered into pages from site/data/*.json (no runtime fetch)
//  - shared header/footer partials, JS/CSS bundled, minified and content-hashed
//  - HTML minified, comments stripped
import { readFile, writeFile, mkdir, rm, readdir, stat, copyFile } from "node:fs/promises";
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

const NAV = [
  ["/#work", "Work"],
  ["/past-work.html", "Past work"],
  ["/kilns.html", "Kilns"],
  ["/terms.html", "Terms"],
  ["/#about", "About"],
  ["/shop.html", "Shop"],
];

const esc = (s = "") => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const mb = (bytes) => (bytes / 1048576).toFixed(1) + " MB";

async function newer(src, out) {
  try { return (await stat(out)).mtimeMs >= (await stat(src)).mtimeMs; } catch { return false; }
}

// Encodes each master once into .cache, then copies into dist, so rebuilds are fast.
async function images() {
  const meta = {};
  for (const dir of await readdir(path.join(SRC, "images"))) {
    const srcDir = path.join(SRC, "images", dir);
    await mkdir(path.join(CACHE, dir), { recursive: true });
    await mkdir(path.join(OUT, "img", dir), { recursive: true });
    for (const file of (await readdir(srcDir)).filter((f) => /\.jpe?g$/i.test(f))) {
      const src = path.join(srcDir, file);
      const base = path.parse(file).name;
      const { width, height } = await sharp(src).metadata();
      const entry = { dir, base, width, height };
      for (const w of WIDTHS.filter((w) => w <= width || w === WIDTHS[0])) {
        const name = `${base}-${w}.webp`;
        const cached = path.join(CACHE, dir, name);
        if (!(await newer(src, cached))) {
          await sharp(src).resize({ width: w, withoutEnlargement: true }).webp({ quality: w <= 400 ? 70 : 76, effort: 6 }).toFile(cached);
        }
        await copyFile(cached, path.join(OUT, "img", dir, name));
      }
      const full = path.join(SRC, "images-full", dir, file);
      try {
        const { size } = await stat(full);
        await mkdir(path.join(OUT, "full", dir), { recursive: true });
        await copyFile(full, path.join(OUT, "full", dir, file));
        entry.full = { url: `full/${dir}/${file}`, size };
      } catch { /* no full-size version for this image */ }
      meta[`images/${dir}/${file}`] = entry;
    }
  }
  return meta;
}

function figureHtml(entry, meta, eager) {
  const m = meta[entry.image];
  if (!m) throw new Error(`Missing image ${entry.image}`);
  const url = (w) => `img/${m.dir}/${m.base}-${w}.webp`;
  const widths = WIDTHS.filter((w) => w <= m.width || w === WIDTHS[0]);
  // The 1600px size is only fetched when a visitor opens the lightbox.
  const srcset = widths.filter((w) => w < 1600).map((w) => `/${url(w)} ${w}w`).join(", ");
  const alt = esc(entry.alt ?? entry.title);
  const full = m.full ? ` data-full="/${m.full.url}" data-full-size="${mb(m.full.size)}"` : "";
  return `<figure class="card">
<a href="/${url(widths.at(-1))}" class="zoom" data-alt="${alt}" data-title="${esc(entry.title)}"${full}>
<img src="/${url(400)}" srcset="${srcset}" sizes="(min-width:1100px) 340px, (min-width:600px) 45vw, 92vw"
 width="${m.width}" height="${m.height}" alt="${alt}" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async"></a>
<figcaption class="card-body"><h3>${esc(entry.title)}</h3>${entry.description ? `<p>${esc(entry.description)}</p>` : ""}</figcaption>
</figure>`;
}

async function gallery(file, meta, eagerFirst = false) {
  const items = JSON.parse(await readFile(path.join(SRC, "data", file), "utf8"));
  return `<div class="grid">${items.map((e, i) => figureHtml(e, meta, eagerFirst && i === 0)).join("\n")}</div>`;
}

async function ogImage() {
  const src = path.join(SRC, "images", "work", "08.jpg");
  await sharp(src).resize(1200, 630, { fit: "cover" }).jpeg({ quality: 78, mozjpeg: true }).toFile(path.join(OUT, "img", "og.jpg"));
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
  return `${links}<a class="cart-link" href="/shop.html#cart" aria-label="Cart">Cart <span class="badge" data-cart-count data-n="0">0</span></a>`;
}

async function page(name, replacements) {
  let html = await readFile(path.join(SRC, name), "utf8");
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
  });
  await writeFile(path.join(OUT, name), out);
  return out.length;
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const meta = await images();
await ogImage();
await copyFile(path.join(SRC, "favicon.svg"), path.join(OUT, "favicon.svg"));
const assets = await bundle();
const [header, footer] = await Promise.all(["header.html", "footer.html"].map((f) => readFile(path.join(SRC, "partials", f), "utf8")));

const common = (current, js = assets.site) => ({
  "<!--header-->": header.replace("{{nav}}", nav(current)),
  "<!--footer-->": footer,
  "{{css}}": "/" + assets.style,
  "{{js}}": "/" + js,
  "{{year}}": String(new Date().getFullYear()),
  "{{og}}": `${SITE_URL}/img/og.jpg`,
  "{{url}}": SITE_URL + "/",
});

const sizes = {
  "index.html": await page("index.html", {
    ...common(""),
    "<!--work-->": await gallery("work.json", meta, true),
    "<!--artist-->": await gallery("artist.json", meta),
  }),
  "past-work.html": await page("past-work.html", { ...common("/past-work.html"), "<!--archive-->": await gallery("archive.json", meta, true) }),
  "kilns.html": await page("kilns.html", {
    ...common("/kilns.html"),
    "<!--kiln-shed-->": await gallery("kiln-shed.json", meta, true),
    "<!--soda-kiln-->": await gallery("soda-kiln.json", meta),
  }),
  "terms.html": await page("terms.html", common("/terms.html")),
  "shop.html": await page("shop.html", common("/shop.html", assets.shop)),
  "error.html": await page("error.html", common("")),
};

console.log("Built dist/", Object.entries(sizes).map(([k, v]) => `${k} ${(v / 1024).toFixed(1)}KB`).join(", "));
if (!SITE_URL) console.warn("SITE_URL not set: og:image will be a relative URL. Use SITE_URL=https://yourdomain npm run build before deploying.");
