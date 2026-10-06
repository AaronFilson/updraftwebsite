// Serves dist/ for local preview and the browser tests, with the content types the CDN uses and
// error.html for anything missing (like CloudFront). No dependencies.
//   node scripts/serve.mjs [port]     (default 4173)
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const DIST = path.resolve(import.meta.dirname, "..", "dist");
const port = Number(process.argv[2] ?? process.env.PORT ?? 4173);
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

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  let file = path.join(DIST, decodeURIComponent(url.pathname));
  if (!file.startsWith(DIST)) return res.writeHead(400).end();
  try {
    if ((await stat(file)).isDirectory()) file = path.join(file, "index.html");
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(await readFile(file));
  } catch {
    res.writeHead(404, { "content-type": TYPES[".html"] }).end(await readFile(path.join(DIST, "error.html")).catch(() => "Not found"));
  }
}).listen(port, () => console.log(`Serving dist/ at http://localhost:${port}`));
