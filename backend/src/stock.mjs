// Stock rules and the recent-sales ledger. Pure functions plus one in-memory map; no Square calls.
//
// Square records a sale at once, but the stock count it reports catches up a few seconds later.
// So this instance remembers what it has just sold and subtracts any sale newer than the count's
// calculatedAt. Checkout runs one order at a time (Checkout function, concurrency 1), so the next
// checkout always sees the previous sale; after an idle restart the memory is empty, but by then
// Square's count has caught up.
const SALE_MEMORY_MS = 10 * 60_000;
const recentSales = new Map(); // variation id -> [{ qty, at }]

export const _resetSales = () => recentSales.clear(); // for tests

export function recordSale(lines, at = Date.now()) {
  for (const l of lines) recentSales.set(l.variationId, [...(recentSales.get(l.variationId) ?? []), { qty: l.quantity, at }]);
}

// counts: id -> quantity, asOf: id -> ms timestamp the count was calculated. Mutates and returns counts.
export function applyRecentSales(counts, asOf, now = Date.now()) {
  for (const [id, sales] of recentSales) {
    const kept = sales.filter((x) => now - x.at < SALE_MEMORY_MS);
    if (!kept.length) {
      recentSales.delete(id);
      continue;
    }
    recentSales.set(id, kept);
    if (!counts.has(id)) continue;
    const pending = kept.filter((x) => x.at > (asOf.get(id) ?? 0)).reduce((n, x) => n + x.qty, 0);
    counts.set(id, counts.get(id) - pending);
  }
  return counts;
}

// info: variation id -> { name, tracked, soldOut }. Stock is null when not tracked (no limit).
export function stockOf(info, counts, id) {
  const v = info.get(id);
  if (!v) return 0;
  if (v.soldOut) return 0;
  if (!v.tracked) return null;
  return Math.max(0, Math.floor(counts.get(id) ?? 0));
}

// Cart lines that can't be filled right now, with names for the message.
export function soldLines(lines, info, counts) {
  return lines
    .filter((l) => {
      const stock = stockOf(info, counts, l.variationId);
      return stock !== null && stock < l.quantity;
    })
    .map((l) => ({ variationId: l.variationId, name: info.get(l.variationId)?.name ?? "An item" }));
}
