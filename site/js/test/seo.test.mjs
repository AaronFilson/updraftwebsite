import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const SITE = path.resolve(import.meta.dirname, "..", "..");
const PAGES = ["index.html", "shop.html", "past-work.html", "about.html", "kilns.html", "terms.html", "care.html", "policies.html"];

test("every indexable page has one h1, a title <= 60 chars, and a 70-160 char description", async () => {
  for (const name of PAGES) {
    const html = await readFile(path.join(SITE, name), "utf8");
    const title = (html.match(/<title>(.*?)<\/title>/)?.[1] ?? "").replaceAll("&amp;", "&");
    const desc = (html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "").replaceAll("&amp;", "&");
    const h1s = html.match(/<h1\b/g) ?? [];
    assert.equal(h1s.length, 1, `${name}: expected one <h1>`);
    for (const [tag, inner] of html.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/g)) {
      const text = inner
        .replace(/<[^>]*>/g, "")
        .replaceAll("&nbsp;", "")
        .trim();
      assert.ok(text.length > 0, `${name}: empty heading ${tag}`);
    }
    assert.ok(title.length >= 20 && title.length <= 60, `${name}: title length ${title.length} ("${title}")`);
    assert.ok(desc.length >= 70 && desc.length <= 160, `${name}: description length ${desc.length}`);
    if (name !== "index.html") assert.ok(html.includes("<!--crumbs-->"), `${name}: missing <!--crumbs--> placeholder`);
  }
});

test("every term in terms.json has a unique anchor id and valid link", async () => {
  const terms = JSON.parse(await readFile(path.join(SITE, "data", "terms.json"), "utf8"));
  assert.ok(terms.length >= 18);
  const ids = terms.map((t) => t.id);
  assert.ok(
    ids.every((id) => /^[a-z0-9-]+$/.test(id)),
    "every term must have a lowercase kebab-case id",
  );
  assert.equal(new Set(ids).size, ids.length, "duplicate term id in terms.json");
  for (const t of terms) {
    assert.ok(t.term?.trim() && t.definition?.trim(), `${t.id}: missing term or definition`);
    if (t.link) assert.match(t.link.href, /^(https:\/\/|\/)/, `${t.id}: invalid link href`);
  }
});
