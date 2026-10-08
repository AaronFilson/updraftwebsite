// Serves dist/ for local preview and the browser tests, with the content types the CDN uses and
// error.html for anything missing (like CloudFront). No dependencies.
//   node scripts/serve.mjs [port]                                          (default 4173)
//   node scripts/serve.mjs --api https://staging.updraftpotterystudio.com  also send /api/* there,
//     so the shop and the home page's "Available now" show real (sandbox) pieces locally
//   node scripts/serve.mjs --catalog e2e/fixtures/catalog.json  answer /api/catalog from a file
//     (Lighthouse: a shop with pieces, no network, no failed request in the console)
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const DIST = path.resolve(import.meta.dirname, "..", "dist");
const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const port = Number(args.find((a) => /^\d+$/.test(a)) ?? process.env.PORT ?? 4173);
const API = option("--api")?.replace(/\/$/, "");
const CATALOG = option("--catalog");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain",
  ".xml": "text/xml",
};

// Pass an /api/* request through to the deployed site (its CloudFront signs it for the functions).
async function proxy(req, res, url) {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks);
    const headers = Object.fromEntries(
      ["content-type", "x-amz-content-sha256"].filter((h) => req.headers[h]).map((h) => [h, req.headers[h]]),
    );
    const r = await fetch(API + url.pathname + url.search, { method: req.method, headers, body });
    res
      .writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" })
      .end(Buffer.from(await r.arrayBuffer()));
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ errors: [`Proxy to ${API} failed: ${err.message}`] }));
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (CATALOG && url.pathname === "/api/catalog")
    return res.writeHead(200, { "content-type": TYPES[".json"], "cache-control": "no-store" }).end(await readFile(CATALOG));
  if (API && url.pathname.startsWith("/api/")) return proxy(req, res, url);
  let file = path.join(DIST, decodeURIComponent(url.pathname));
  if (!file.startsWith(DIST)) return res.writeHead(400).end();
  try {
    if ((await stat(file)).isDirectory()) file = path.join(file, "index.html");
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(await readFile(file));
  } catch {
    res.writeHead(404, { "content-type": TYPES[".html"] }).end(await readFile(path.join(DIST, "error.html")).catch(() => "Not found"));
  }
}).listen(port, () =>
  console.log(
    `Serving dist/ at http://localhost:${port}${API ? `, /api/* from ${API}` : ""}${CATALOG ? `, /api/catalog from ${CATALOG}` : ""}`,
  ),
);
