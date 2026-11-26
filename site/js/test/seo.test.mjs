import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const SITE = path.resolve(import.meta.dirname, "..", "..");
const PAGES = ["index.html", "shop.html", "past-work.html", "about.html", "kilns.html", "terms.html", "care.html", "policies.html"];
const unesc = (s = "") => s.replace(/&(amp|lt|gt|quot);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"' })[e]);

test("every indexable page has one h1, a title <= 60 chars, and a 70-160 char description", async () => {
  for (const name of PAGES) {
    const html = await readFile(path.join(SITE, name), "utf8");
    const title = unesc(html.match(/<title>(.*?)<\/title>/)?.[1] ?? "");
    const desc = unesc(html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "");
    const h1s = html.match(/<h1\b/g) ?? [];
    assert.equal(h1s.length, 1, `${name}: expected one <h1>`);
    assert.ok(title.length >= 20 && title.length <= 60, `${name}: title length ${title.length} ("${title}")`);
    assert.ok(desc.length >= 70 && desc.length <= 160, `${name}: description length ${desc.length}`);
    if (name !== "index.html") assert.ok(html.includes("<!--crumbs-->"), `${name}: missing <!--crumbs--> placeholder`);
  }
});

test("every term in terms.html has a unique anchor id", async () => {
  const html = await readFile(path.join(SITE, "terms.html"), "utf8");
  const dts = [...html.matchAll(/<dt\b([^>]*)>/g)];
  assert.ok(dts.length >= 15);
  const ids = dts.map(([, attrs]) => attrs.match(/\bid="([a-z0-9-]+)"/)?.[1]);
  assert.ok(ids.every(Boolean), "every <dt> must have a lowercase kebab-case id");
  assert.equal(new Set(ids).size, ids.length, "duplicate <dt id> in terms.html");
});
