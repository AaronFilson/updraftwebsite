// Makes every resized copy of the shop's photos that the site asks for, so the first visitors after
// new pieces go up get them from CloudFront's cache instead of all waiting on the resizer at once (it
// handles imagesConcurrency at a time, deploy/stages.json; past that it answers 429).
// Asks two at a time, through the site like a visitor. Run it a minute after photos change in
// Square (load-items, replace-photos or the Dashboard), once the shop shows the new photos.
//   npm run warm-photos                     production
//   npm run warm-photos -- --stage staging  staging
import { currentStage } from "./stage.mjs";

const stage = currentStage();
const AT_ONCE = 2;

// The sizes the site uses (site/js/shop.js cards, site/js/piece-view.js, and backend/src/piece-page.mjs:
// the piece page's photos, and the 1200px JPEGs in its preview and product data).
const MAIN = [
  [400, "avif"],
  [400, "webp"],
  [800, "avif"],
  [800, "webp"],
  [1600, "avif"],
  [1600, "webp"],
  [1200, "jpeg"],
];
const OTHER = MAIN.filter(([w]) => w !== 400);

const res = await fetch(`${stage.siteUrl}/api/catalog`);
if (!res.ok) throw new Error(`${stage.siteUrl}/api/catalog answered ${res.status}`);
const body = await res.json();
const urls = (body.items ?? body).flatMap((item) =>
  (item.images?.length ? item.images : [item.image].filter(Boolean)).flatMap((photo, i) =>
    (i === 0 ? MAIN : OTHER).map(([w, f]) => `${stage.siteUrl}/api/img?u=${encodeURIComponent(photo)}&w=${w}&f=${f}`),
  ),
);
console.log(`Warming ${urls.length} photo copies on ${stage.siteUrl}, ${AT_ONCE} at a time`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tally = { hit: 0, made: 0, failed: [] };
async function warm(url) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const r = await fetch(url);
    await r.arrayBuffer();
    if (r.ok) return tally[/hit/i.test(r.headers.get("x-cache") ?? "") ? "hit" : "made"]++;
    // 429/5xx: the resizer is busy. 404: the resizer hasn't seen the new catalog yet, and CloudFront
    // keeps that answer for a minute.
    if (r.status === 404 && attempt < 3) await sleep(65_000);
    else if ((r.status === 429 || r.status >= 500) && attempt < 5) await sleep(1000 * 2 ** attempt);
    else return tally.failed.push(`${r.status} ${url}`);
  }
}
const queue = [...urls];
await Promise.all(
  Array.from({ length: AT_ONCE }, async () => {
    while (queue.length) await warm(queue.shift());
  }),
);
console.log(`Done: ${tally.made} made, ${tally.hit} already cached, ${tally.failed.length} failed`);
if (tally.failed.length) {
  console.log(tally.failed.join("\n"));
  process.exitCode = 1;
}
