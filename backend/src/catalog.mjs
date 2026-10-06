// The shop catalog from Square, with live stock.
import { SQUARE_LOCATION_ID, square, onSquareReset } from "./config.mjs";
import { applyRecentSales, stockOf, soldLines } from "./stock.mjs";

// Short, so a piece that sells shows "Sold" quickly; checkout always re-reads live stock anyway.
const CATALOG_TTL_MS = 15_000;
let cache = { at: 0, items: [], info: new Map() };
onSquareReset(() => {
  cache = { at: 0, items: [], info: new Map() };
});

// Square stock at our location for tracked variations, less sales the count doesn't include yet.
// Tracked but never counted = 0.
async function liveStock(ids) {
  const out = new Map(ids.map((id) => [id, 0]));
  if (!ids.length) return out;
  const asOf = new Map();
  const pager = await square().inventory.batchGetCounts({ catalogObjectIds: ids, locationIds: [SQUARE_LOCATION_ID], states: ["IN_STOCK"] });
  for await (const c of pager) {
    out.set(c.catalogObjectId, Number(c.quantity));
    asOf.set(c.catalogObjectId, Date.parse(c.calculatedAt) || 0);
  }
  return applyRecentSales(out, asOf);
}

export async function loadCatalog() {
  if (Date.now() - cache.at < CATALOG_TTL_MS) return cache.items;

  const objects = [];
  const pager = await square().catalog.list({ types: "ITEM,IMAGE" });
  for await (const obj of pager) objects.push(obj);

  const images = new Map(objects.filter((o) => o.type === "IMAGE").map((o) => [o.id, o.imageData?.url]));
  const info = new Map();
  const items = objects
    .filter((o) => o.type === "ITEM" && !o.isDeleted && o.itemData?.productType !== "APPOINTMENTS_SERVICE")
    .filter((o) => !o.itemData.isArchived)
    .map((o) => ({
      id: o.id,
      name: o.itemData.name,
      description: o.itemData.descriptionPlaintext ?? o.itemData.description ?? "",
      image: images.get(o.itemData.imageIds?.[0]) ?? null,
      variations: (o.itemData.variations ?? [])
        .filter((v) => v.itemVariationData?.priceMoney)
        .map((v) => {
          const d = v.itemVariationData;
          const here = d.locationOverrides?.find((x) => x.locationId === SQUARE_LOCATION_ID);
          const name = o.itemData.variations.length > 1 ? `${o.itemData.name} (${d.name})` : o.itemData.name;
          info.set(v.id, { name, tracked: Boolean(here?.trackInventory ?? d.trackInventory), soldOut: Boolean(here?.soldOut) });
          return { id: v.id, name: d.name, price: Number(d.priceMoney.amount), currency: d.priceMoney.currency };
        }),
    }))
    .filter((i) => i.variations.length);

  const counts = await liveStock([...info].filter(([, v]) => v.tracked).map(([id]) => id));
  for (const item of items) for (const v of item.variations) v.stock = stockOf(info, counts, v.id);
  // Pieces still for sale first; sold pieces stay listed (marked Sold) after them.
  items.sort((a, b) => Number(a.variations.every((v) => v.stock === 0)) - Number(b.variations.every((v) => v.stock === 0)));

  cache = { at: Date.now(), items, info };
  return items;
}

// Live check (never cached) of whether the cart can still be filled.
export async function checkStock(lines) {
  await loadCatalog();
  const tracked = [...new Set(lines.map((l) => l.variationId))].filter((id) => cache.info.get(id)?.tracked);
  return soldLines(lines, cache.info, await liveStock(tracked));
}

export async function unknownLines(lines) {
  const known = new Set((await loadCatalog()).flatMap((i) => i.variations.map((v) => v.id)));
  return lines.some((l) => !known.has(l.variationId));
}
