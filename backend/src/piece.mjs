// GET /p/<item id>: the page for one piece, for search engines, shared links and anyone who wants to
// look at it closely (drawn by piece-page.mjs). GET /p/sitemap.xml: every piece's address. A sitemap
// under /p/ may only list pages under /p/, which is all it needs, and the /p/* route is already here.
import { ALLOWED_ORIGIN } from "./config.mjs";
import { loadCatalog } from "./catalog.mjs";
import { renderPiece, gonePage, piecesSitemap } from "./piece-page.mjs";

const site = () => (ALLOWED_ORIGIN === "*" ? "" : ALLOWED_ORIGIN);
const reply = (status, type, body, cache) => ({
  statusCode: status,
  headers: { "content-type": `${type}; charset=utf-8`, "cache-control": cache },
  body,
});

// The site's page shell, read through CloudFront like a visitor and kept 5 minutes, so a publish
// restyles the piece pages without deploying the API. If it can't be read, the last good copy is
// used; with none, the plain page, asked again in a minute.
const SHELL_TTL_MS = 5 * 60_000;
let shell = { at: 0, html: null };
let reading;
async function readShell() {
  try {
    const res = await fetch(`${site()}/piece-shell.html`, { signal: AbortSignal.timeout(3_000), redirect: "error" });
    const html = res.ok ? await res.text() : "";
    if (!html.includes("[[piece]]")) throw new Error(`shell answered ${res.status}`);
    shell = { at: Date.now(), html };
  } catch (err) {
    console.error("PIECE_SHELL_FAILED", err.message);
    shell = { at: Date.now() - SHELL_TTL_MS + 60_000, html: shell.html };
  }
}
async function pageShell() {
  if (!site()) return null; // local runs and tests: no site to read it from
  if (Date.now() - shell.at > SHELL_TTL_MS) await (reading ??= readShell().finally(() => (reading = undefined)));
  return shell.html;
}
// For tests: forget the shell read so far.
export const _resetShell = () => {
  shell = { at: 0, html: null };
};

export async function piece(id) {
  const items = /^[A-Za-z0-9_-]{1,64}$/.test(id) ? await loadCatalog() : [];
  const item = items.find((i) => i.id === id);
  // 410 Gone, not 404: CloudFront swaps every 403/404 for the site's error page (deploy/site.yaml), and
  // someone following an old link should hear that the piece has gone, with a way to the shop.
  if (!item) return reply(410, "text/html", gonePage(), "public, max-age=60");
  const html = await pageShell();
  // Without the shell the page is the plain fallback: kept only briefly.
  return reply(
    200,
    "text/html",
    renderPiece({ item, items, shell: html, site: site() }),
    html ? "public, max-age=300" : "public, max-age=60",
  );
}

export async function sitemap() {
  return reply(200, "application/xml", piecesSitemap(await loadCatalog(), site()), "public, max-age=300");
}
