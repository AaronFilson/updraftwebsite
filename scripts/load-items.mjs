// Loads a batch of pieces into a stage's Square catalog: categories, the "Ship weight (lb)" attribute,
// then each item with its price, description ("<glaze> · <size>" then "Lantern motif."), category, ship
// weight, photos (cropped as the batch says, see scripts/listing-photo.mjs) and a stock count of 1 at the stage's location.
// Without --go it only prints what it would do. Items whose name is already in the catalog are skipped,
// so a run that stopped part way can be run again.
//   node scripts/load-items.mjs scripts/items/2026-10-13.json --stage staging        dry run
//   node scripts/load-items.mjs scripts/items/2026-10-13.json --stage staging --go   load
//   node scripts/load-items.mjs scripts/items/2026-10-13.json --go                   production
// Options: --photos <folder> overrides the batch file's photoDir.
import { readFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { currentStage } from "./stage.mjs";
import { squareClient, squareErrorMessage } from "./square-client.mjs";
import { ensureShipWeightAttribute, SHIP_LB_KEY } from "./ship-weight-attribute.mjs";
import { listingJpeg } from "./listing-photo.mjs";

const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const file = args.find((a) => a.endsWith(".json"));
if (!file) throw new Error("Usage: node scripts/load-items.mjs <batch.json> [--stage staging] [--photos <folder>] [--go]");
const GO = args.includes("--go");
const stage = currentStage();
const batch = JSON.parse(readFileSync(file, "utf8"));
const photoDir = opt("--photos") ?? batch.photoDir;

// Check everything local before touching Square.
const problems = [];
for (const it of batch.items) {
  if (!(it.price > 0) || !(it.shipLb > 0) || !it.category || !it.size || !it.photos?.length) problems.push(`${it.name}: incomplete entry`);
  for (const p of it.photos ?? [])
    if (!existsSync(path.join(photoDir, p))) problems.push(`${it.name}: missing photo ${path.join(photoDir, p)}`);
}
if (problems.length) throw new Error(`Fix the batch file first:\n  ${problems.join("\n  ")}`);

console.log(
  `${GO ? "Loading" : "Dry run (add --go to load)"}: ${batch.items.length} items into Square ${stage.squareEnv} for stage "${stage.name}", location ${stage.squareLocationId}`,
);
const square = await squareClient(stage);

try {
  const existing = new Set();
  const categories = new Map();
  for await (const o of await square.catalog.list({ types: "ITEM,CATEGORY" })) {
    if (o.isDeleted) continue;
    if (o.type === "ITEM") existing.add(o.itemData.name);
    else categories.set(o.categoryData.name, o.id);
  }

  const shipDef = await ensureShipWeightAttribute(square, { dryRun: !GO });
  console.log(`"Ship weight (lb)" attribute: ${shipDef.created ? (GO ? "created" : "would be created") : "already there"}`);

  for (const name of new Set(batch.items.map((i) => i.category))) {
    if (categories.has(name)) continue;
    console.log(`category ${name}: ${GO ? "created" : "would be created"}`);
    if (!GO) continue;
    const { catalogObject } = await square.catalog.object.upsert({
      idempotencyKey: randomUUID(),
      object: { type: "CATEGORY", id: "#category", categoryData: { name } },
    });
    categories.set(name, catalogObject.id);
  }

  for (const it of batch.items) {
    if (existing.has(it.name)) {
      console.log(`skip   ${it.name} (already in the catalog)`);
      continue;
    }
    const description = `${batch.glaze} · ${it.size}\nLantern motif.`;
    console.log(
      `${GO ? "create" : "would create"} ${it.name}  $${it.price}  [${it.category}]  ship ${it.shipLb} lb  ${it.photos.length} photo(s)`,
    );
    if (!GO) continue;
    const categoryId = categories.get(it.category);
    const { catalogObject: item } = await square.catalog.object.upsert({
      idempotencyKey: randomUUID(),
      object: {
        type: "ITEM",
        id: "#item",
        customAttributeValues: { [SHIP_LB_KEY]: { customAttributeDefinitionId: shipDef.id, numberValue: String(it.shipLb) } },
        itemData: {
          name: it.name,
          description,
          categories: [{ id: categoryId }],
          reportingCategory: { id: categoryId },
          productType: "REGULAR",
          variations: [
            {
              type: "ITEM_VARIATION",
              id: "#variation",
              itemVariationData: {
                name: "Regular",
                pricingType: "FIXED_PRICING",
                priceMoney: { amount: BigInt(Math.round(it.price * 100)), currency: "USD" },
                trackInventory: true,
              },
            },
          ],
        },
      },
    });
    // Photos in the order listed; the first is the main one.
    for (const [i, photo] of it.photos.entries()) {
      const jpeg = await listingJpeg(path.join(photoDir, photo), batch.crops?.[photo], batch.fill);
      await square.catalog.images.create({
        request: {
          idempotencyKey: randomUUID(),
          objectId: item.id,
          isPrimary: i === 0,
          image: { type: "IMAGE", id: "#image", imageData: { name: `${it.name} ${i + 1}`, caption: it.name } },
        },
        imageFile: new Blob([jpeg], { type: "image/jpeg" }),
      });
    }
    await square.inventory.batchCreateChanges({
      idempotencyKey: randomUUID(),
      changes: [
        {
          type: "PHYSICAL_COUNT",
          physicalCount: {
            catalogObjectId: item.itemData.variations[0].id,
            locationId: stage.squareLocationId,
            state: "IN_STOCK",
            quantity: "1",
            occurredAt: new Date().toISOString(),
          },
        },
      ],
    });
    console.log(`       done: ${item.id}`);
  }
} catch (err) {
  console.error(squareErrorMessage(err));
  process.exitCode = 1;
}
