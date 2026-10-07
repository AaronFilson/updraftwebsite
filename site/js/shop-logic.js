// The shop's decisions, kept free of the page so they can be unit-tested (site/js/test/).
import { lineMax } from "./cart.js";

/** @typedef {{ variationId: string, itemName: string, variationName?: string, price: number, quantity: number, max?: number }} Line */
/** @typedef {Map<string, { stock: number | null, name: string }>} StockById */

/**
 * Brings a saved cart in line with the latest catalog: drops pieces that sold or disappeared and
 * caps quantities at what is in stock (stock null = no limit).
 * @param {Line[]} lines
 * @param {StockById} stockById
 * @returns {{ lines: Line[], gone: string[] }}
 */
export function reconcile(lines, stockById) {
  const gone = [];
  const kept = [];
  for (const l of lines) {
    const s = stockById.get(l.variationId);
    if (!s || s.stock === 0) {
      gone.push(s?.name ?? l.itemName);
      continue;
    }
    const max = s.stock ?? undefined;
    kept.push({ ...l, max, quantity: Math.min(l.quantity, lineMax({ max })) });
  }
  return { lines: kept, gone };
}

/** "A has sold and was removed…" / "A and B have sold and were removed…" @param {string[]} names */
export const goneMessage = (names) =>
  `${names.join(" and ")} ${names.length > 1 ? "have" : "has"} sold and ${names.length > 1 ? "were" : "was"} removed from your cart.`;

/** Appends the right "It was / They were removed" to the server's "just sold" message. */
export const removedMessage = (/** @type {string} */ message, /** @type {number} */ count) =>
  `${message} ${count > 1 ? "They were" : "It was"} removed from your cart.`;

/** @param {Line[]} cart */
export const subtotal = (cart) => cart.reduce((n, l) => n + l.price * l.quantity, 0);

/** Identifies a cart + fulfillment for tax quotes, so an unchanged cart isn't looked up again. */
export const quoteKey = (/** @type {Line[]} */ cart, /** @type {string} */ fulfillment) =>
  JSON.stringify([cart.map((l) => [l.variationId, l.quantity]), fulfillment]);

/** Optional phone: empty is fine, otherwise 10-15 digits in any common format. */
export function phoneOk(/** @type {string} */ value) {
  if (!value.trim()) return true;
  const digits = value.replace(/\D/g, "").length;
  return digits >= 10 && digits <= 15;
}

/** A label's text as it reads in an error message: "ZIP code" stays, "Full name" -> "full name". */
export const fieldName = (/** @type {string} */ labelText) =>
  labelText
    .trim()
    .replace(/\s*\(.*\)$/, "")
    .split(" ")
    .map((w) => (w === w.toUpperCase() ? w : w.toLowerCase()))
    .join(" ");
