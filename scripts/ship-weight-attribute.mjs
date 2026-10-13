// Creates the "Ship weight (lb)" custom attribute on Square items, once per Square account. Shipping
// is priced from it (backend/src/shipping.mjs); fill it in for each item in Square Dashboard.
// The token is taken from SQUARE_ACCESS_TOKEN or backend/.env and never printed.
//   node scripts/ship-weight-attribute.mjs                     production
//   node scripts/ship-weight-attribute.mjs --stage staging     staging
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { currentStage } from "./stage.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
// The Square SDK is a backend dependency.
const sdk = createRequire(path.join(ROOT, "backend", "package.json")).resolve("square");
const { SquareClient, SquareEnvironment } = await import(pathToFileURL(sdk).href);
const stage = currentStage();

let token = process.env.SQUARE_ACCESS_TOKEN;
const envFile = path.join(ROOT, "backend", ".env");
if (!token && existsSync(envFile))
  token = readFileSync(envFile, "utf8")
    .match(/^\s*SQUARE_ACCESS_TOKEN\s*=\s*['"]?([^'"\r\n]+)/m)?.[1]
    ?.trim();
if (!token) throw new Error("No token: set SQUARE_ACCESS_TOKEN or put it in backend/.env (git-ignored).");

const square = new SquareClient({
  token,
  environment: stage.squareEnv === "production" ? SquareEnvironment.Production : SquareEnvironment.Sandbox,
});

const KEY = "ship_lb"; // must match SHIP_LB_KEY in backend/src/catalog.mjs
const existing = [];
for await (const o of await square.catalog.list({ types: "CUSTOM_ATTRIBUTE_DEFINITION" }))
  if (o.customAttributeDefinitionData?.key === KEY) existing.push(o);
if (existing.length) {
  console.log(`"Ship weight (lb)" already exists in Square ${stage.squareEnv} (${existing[0].id}).`);
} else {
  const { catalogObject } = await square.catalog.object.upsert({
    idempotencyKey: randomUUID(),
    object: {
      type: "CUSTOM_ATTRIBUTE_DEFINITION",
      id: "#ship_lb",
      customAttributeDefinitionData: {
        type: "NUMBER",
        name: "Ship weight (lb)",
        description: "Billed weight of the packed box, from the pack-and-ship planner. Shipping is priced from it; empty = pickup only.",
        key: KEY,
        allowedObjectTypes: ["ITEM"],
        sellerVisibility: "SELLER_VISIBILITY_READ_WRITE_VALUES",
        appVisibility: "APP_VISIBILITY_READ_WRITE_VALUES",
        numberConfig: { precision: 1 },
      },
    },
  });
  console.log(`Created "Ship weight (lb)" in Square ${stage.squareEnv} (${catalogObject.id}).`);
}
