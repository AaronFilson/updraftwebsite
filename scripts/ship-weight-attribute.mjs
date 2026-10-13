// Creates the "Ship weight (lb)" custom attribute on Square items, once per Square account. Shipping
// is priced from it (backend/src/shipping.mjs); fill it in for each item in Square Dashboard, or load
// items with scripts/load-items.mjs, which runs this first.
//   node scripts/ship-weight-attribute.mjs                     production
//   node scripts/ship-weight-attribute.mjs --stage staging     staging
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { currentStage } from "./stage.mjs";
import { squareClient, squareErrorMessage } from "./square-client.mjs";

export const SHIP_LB_KEY = "ship_lb"; // must match SHIP_LB_KEY in backend/src/catalog.mjs

/** The definition's id, created if this Square account doesn't have it yet. */
export async function ensureShipWeightAttribute(square, { dryRun = false } = {}) {
  for await (const o of await square.catalog.list({ types: "CUSTOM_ATTRIBUTE_DEFINITION" }))
    if (!o.isDeleted && o.customAttributeDefinitionData?.key === SHIP_LB_KEY) return { id: o.id, created: false };
  if (dryRun) return { id: null, created: true };
  const { catalogObject } = await square.catalog.object.upsert({
    idempotencyKey: randomUUID(),
    object: {
      type: "CUSTOM_ATTRIBUTE_DEFINITION",
      id: "#ship_lb",
      customAttributeDefinitionData: {
        type: "NUMBER",
        name: "Ship weight (lb)",
        description: "Billed weight of the packed box, from the pack-and-ship planner. Shipping is priced from it; empty = pickup only.",
        key: SHIP_LB_KEY,
        allowedObjectTypes: ["ITEM"],
        sellerVisibility: "SELLER_VISIBILITY_READ_WRITE_VALUES",
        appVisibility: "APP_VISIBILITY_READ_WRITE_VALUES",
        numberConfig: { precision: 1 },
      },
    },
  });
  return { id: catalogObject.id, created: true };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stage = currentStage();
  try {
    const { id, created } = await ensureShipWeightAttribute(await squareClient(stage));
    console.log(`${created ? "Created" : "Already there:"} "Ship weight (lb)" in Square ${stage.squareEnv} (${id}).`);
  } catch (err) {
    console.error(squareErrorMessage(err));
    process.exitCode = 1;
  }
}
