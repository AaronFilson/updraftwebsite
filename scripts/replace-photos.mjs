// Replaces the photos of pieces already in a stage's Square catalog with the batch file's photos, cropped
// as the batch says (see scripts/listing-photo.mjs). Items are matched by name; the old photos are
// deleted once the new ones are on the item. Without --go it only prints what it would do.
//   node scripts/replace-photos.mjs scripts/items/2026-10-13.json --stage staging        dry run
//   node scripts/replace-photos.mjs scripts/items/2026-10-13.json --stage staging --go   replace
//   node scripts/replace-photos.mjs scripts/items/2026-10-13.json --go                   production
// Options: --photos <folder> overrides the batch file's photoDir; --only "<name>" does one piece.
import { readFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { currentStage } from "./stage.mjs";
import { squareClient, squareErrorMessage } from "./square-client.mjs";
import { listingJpeg } from "./listing-photo.mjs";

const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const file = args.find((a) => a.endsWith(".json"));
if (!file)
  throw new Error("Usage: node scripts/replace-photos.mjs <batch.json> [--stage staging] [--photos <folder>] [--only <name>] [--go]");
const GO = args.includes("--go");
const stage = currentStage();
const batch = JSON.parse(readFileSync(file, "utf8"));
const photoDir = opt("--photos") ?? batch.photoDir;
const items = batch.items.filter((it) => !opt("--only") || it.name === opt("--only"));

const missing = items.flatMap((it) => it.photos).filter((p) => !existsSync(path.join(photoDir, p)));
if (missing.length) throw new Error(`Missing photos in ${photoDir}: ${missing.join(", ")}`);
if (!items.length) throw new Error(`No item named "${opt("--only")}" in ${file}`);

console.log(
  `${GO ? "Replacing" : "Dry run (add --go to replace)"}: photos of ${items.length} items in Square ${stage.squareEnv} for stage "${stage.name}"`,
);
const square = await squareClient(stage);

try {
  const byName = new Map();
  for await (const o of await square.catalog.list({ types: "ITEM" })) if (!o.isDeleted) byName.set(o.itemData.name, o.id);

  for (const it of items) {
    const id = byName.get(it.name);
    if (!id) {
      console.log(`skip   ${it.name} (not in the catalog)`);
      continue;
    }
    const { object: before } = await square.catalog.object.get({ objectId: id });
    const old = before.itemData.imageIds ?? [];
    console.log(`${GO ? "replace" : "would replace"} ${it.name}: ${old.length} photo(s) -> ${it.photos.length} cropped`);
    if (!GO) continue;

    // Upload unattached, then point the item at the new photos in the batch's order (the first is the main one).
    const fresh = [];
    for (const [i, photo] of it.photos.entries()) {
      const jpeg = await listingJpeg(path.join(photoDir, photo), batch.crops?.[photo], batch.fill);
      const { image } = await square.catalog.images.create({
        request: {
          idempotencyKey: randomUUID(),
          image: { type: "IMAGE", id: "#image", imageData: { name: `${it.name} ${i + 1}`, caption: it.name } },
        },
        imageFile: new Blob([jpeg], { type: "image/jpeg" }),
      });
      fresh.push(image.id);
    }
    const { object: item } = await square.catalog.object.get({ objectId: id });
    item.itemData.imageIds = fresh;
    await square.catalog.object.upsert({ idempotencyKey: randomUUID(), object: item });
    const stale = old.filter((x) => !fresh.includes(x));
    if (stale.length) await square.catalog.batchDelete({ objectIds: stale });
    console.log(`       done: ${fresh.length} new, ${stale.length} old deleted`);
  }
} catch (err) {
  console.error(squareErrorMessage(err));
  process.exitCode = 1;
}
