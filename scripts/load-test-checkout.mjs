// Load test for the one-of-a-kind guarantee: many buyers check out the same piece (stock 1) at the
// same moment, on a deployed sandbox stage. Exactly one may be charged; every other buyer must hear
// that it sold, with their card not charged. Requests go through CloudFront like the site's (body
// hash, HTTP 429 retries), so this tests the real path: CloudFront, the one-at-a-time Checkout
// function, its recent-sales ledger and Square.
//   npm run load-test -- --stage staging [--buyers 16] [--item "test 2"] [--verify] [--restock]
// --verify  also asks Square how many payments completed and were cancelled (needs the token)
// --restock sets the piece's stock back to 1 afterwards (needs the token)
// The token comes from SQUARE_ACCESS_TOKEN or backend/.env and is never printed. Payments use Square's
// sandbox test card; a stage whose squareEnv is "production" is refused.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { currentStage } from "./stage.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const flag = (name) => args.includes(`--${name}`);
const stage = currentStage();
if (stage.squareEnv !== "sandbox")
  throw new Error(`Refusing: stage ${stage.name} uses Square ${stage.squareEnv}. Load tests run on sandbox only.`);
const SITE = stage.siteUrl;
const BUYERS = Number(opt("buyers", 16));
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

const post = async (route, data) => {
  const body = JSON.stringify(data);
  const sha = createHash("sha256").update(body).digest("hex");
  return fetch(`${SITE}${route}`, { method: "POST", headers: { "content-type": "application/json", "x-amz-content-sha256": sha }, body });
};
const catalog = async () => (await (await fetch(`${SITE}/api/catalog`)).json()).items;

function token() {
  let t = process.env.SQUARE_ACCESS_TOKEN;
  const env = path.resolve(import.meta.dirname, "..", "backend", ".env");
  if (!t && existsSync(env))
    t = readFileSync(env, "utf8")
      .match(/^\s*SQUARE_ACCESS_TOKEN\s*=\s*['"]?([^'"\r\n]+)/m)?.[1]
      ?.trim();
  if (!t) throw new Error("--verify and --restock need SQUARE_ACCESS_TOKEN or backend/.env");
  return t;
}
const square = async (route, body) => {
  const res = await fetch(`https://connect.squareupsandbox.com${route}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token()}`, "Square-Version": "2026-09-16", "content-type": "application/json" },
    body: body && JSON.stringify(body),
  });
  const out = await res.json();
  if (out.errors) throw new Error(`Square ${route}: ${out.errors.map((e) => e.code).join(", ")}`);
  return out;
};

// --- the piece ------------------------------------------------------------------------------------
const items = await catalog();
const wanted = opt("item");
const piece = items.find((i) => (wanted ? i.name === wanted : i.variations.length === 1 && i.variations[0].stock === 1));
if (!piece)
  throw new Error(
    wanted
      ? `No piece named "${wanted}" on ${SITE}`
      : `No one-of-a-kind piece in stock on ${SITE}; set one to stock 1 in Square (or use --item).`,
  );
const variation = piece.variations[0];
if (variation.stock !== 1) throw new Error(`"${piece.name}" has stock ${variation.stock}; set it to 1 first (or run once with --restock).`);
const lines = [{ variationId: variation.id, quantity: 1 }];
const quote = await (await post("/api/quote", { lines, fulfillment: "pickup" })).json();
console.log(`${SITE}: ${BUYERS} buyers, one "${piece.name}" (stock 1), total ${(quote.total / 100).toFixed(2)} each`);

// --- everyone checks out at once -------------------------------------------------------------------
const started = new Date();
async function buyer(n) {
  const body = {
    sourceId: "cnon:card-nonce-ok", // Square's sandbox test card
    idempotencyKey: randomUUID(),
    lines,
    name: `Load test buyer ${n}`,
    email: `load-test-${n}@example.com`,
    fulfillment: "pickup",
    note: "Automated load test",
    billing: { line1: "1 Test Way", city: "Tacoma", state: "WA", postalCode: "98402" },
    expectedTotal: quote.total,
  };
  const t0 = performance.now();
  // Same retry as the site: the Checkout function takes one order at a time and answers 429 meanwhile.
  for (let attempt = 1; ; attempt++) {
    const res = await post("/api/checkout", body);
    if (res.status !== 429 || attempt >= 20) {
      const out = await res.json().catch(() => ({}));
      return { n, status: res.status, out, attempts: attempt, ms: Math.round(performance.now() - t0) };
    }
    await sleep(800 + attempt * 400 + Math.random() * 400);
  }
}
const results = await Promise.all(Array.from({ length: BUYERS }, (_, i) => buyer(i + 1)));

const paid = results.filter((r) => r.status === 200);
const refused = results.filter((r) => r.status === 409 && r.out.sold && r.out.notCharged);
const other = results.filter((r) => !paid.includes(r) && !refused.includes(r));
console.log("\nbuyer  status  attempts  time    result");
for (const r of results.sort((a, b) => a.ms - b.ms))
  console.log(
    `${String(r.n).padStart(5)}  ${r.status}     ${String(r.attempts).padStart(8)}  ${String(r.ms).padStart(5)}ms  ${
      r.status === 200 ? "charged" : r.out.notCharged ? "sold to someone else, not charged" : JSON.stringify(r.out.errors ?? r.out)
    }`,
  );

// --- what the shop and Square say afterwards -------------------------------------------------------
await sleep(16_000); // the catalog is cached for 15 s
const after = (await catalog()).find((i) => i.id === piece.id)?.variations[0].stock;
const checks = [
  [`exactly one buyer charged (${paid.length})`, paid.length === 1],
  [`every other buyer told it sold, card not charged (${refused.length} of ${BUYERS - 1})`, refused.length === BUYERS - 1],
  [`no other outcomes (${other.length})`, other.length === 0],
  [`shop shows stock 0 afterwards (${after})`, after === 0],
];
if (flag("verify")) {
  const { payments = [] } = await square(`/v2/payments?begin_time=${started.toISOString()}&location_id=${stage.squareLocationId}`);
  const ours = payments.filter((p) => Number(p.amount_money?.amount) === quote.total);
  const completed = ours.filter((p) => p.status === "COMPLETED").length;
  const leftOpen = ours.filter((p) => p.status === "APPROVED").length; // authorised but neither charged nor cancelled
  checks.push(
    [`Square: one completed payment (${completed})`, completed === 1],
    [`Square: no authorisations left open (${leftOpen})`, leftOpen === 0],
  );
}
if (flag("restock")) {
  await square("/v2/inventory/changes/batch-create", {
    idempotency_key: randomUUID(),
    changes: [
      {
        type: "PHYSICAL_COUNT",
        physical_count: {
          catalog_object_id: variation.id,
          location_id: stage.squareLocationId,
          state: "IN_STOCK",
          quantity: "1",
          occurred_at: new Date().toISOString(),
        },
      },
    ],
  });
  console.log(`\n"${piece.name}" restocked to 1.`);
}
console.log("");
for (const [what, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
