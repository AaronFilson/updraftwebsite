// Cart kept in localStorage as [{variationId, itemName, variationName, price, quantity, max?}]
// max is the stock available when the line was added (absent = no limit beyond MAX_QTY).
const KEY = "updraft-cart";
const MAX_QTY = 10;
const cap = (l) => Math.min(MAX_QTY, l.max ?? MAX_QTY);

export const getCart = () => {
  try {
    return JSON.parse(localStorage.getItem(KEY)) ?? [];
  } catch {
    return [];
  }
};
const save = (c) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    /* private mode */
  }
  document.dispatchEvent(new CustomEvent("cart-changed"));
};

// Returns false when the line is already at its limit (e.g. a one-of-a-kind piece already in the cart).
export function addToCart(line) {
  const cart = getCart();
  const hit = cart.find((l) => l.variationId === line.variationId);
  if (hit) {
    hit.max = line.max;
    if (hit.quantity >= cap(hit)) return false;
    hit.quantity += 1;
  } else cart.push({ ...line, quantity: 1 });
  save(cart);
  return true;
}
export function setQuantity(variationId, quantity) {
  save(
    getCart()
      .map((l) => (l.variationId === variationId ? { ...l, quantity: Math.min(quantity, cap(l)) } : l))
      .filter((l) => l.quantity > 0),
  );
}
// Bulk rewrite (used to drop sold pieces and refresh stock limits); fn gets and returns the line array.
export const updateCart = (fn) => save(fn(getCart()).filter((l) => l.quantity > 0));
export const clearCart = () => save([]);
export const cartCount = () => getCart().reduce((n, l) => n + l.quantity, 0);
export const lineMax = cap;
export const money = (cents, cur = "USD") => new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(cents / 100);
