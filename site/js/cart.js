// Cart kept in localStorage as [{variationId, itemName, variationName, price, quantity}]
const KEY = "updraft-cart";

export const getCart = () => {
  try { return JSON.parse(localStorage.getItem(KEY)) ?? []; } catch { return []; }
};
const save = (c) => {
  try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* private mode */ }
  document.dispatchEvent(new CustomEvent("cart-changed"));
};

export function addToCart(line) {
  const cart = getCart();
  const hit = cart.find((l) => l.variationId === line.variationId);
  if (hit) hit.quantity = Math.min(10, hit.quantity + 1);
  else cart.push({ ...line, quantity: 1 });
  save(cart);
}
export function setQuantity(variationId, quantity) {
  save(getCart().map((l) => (l.variationId === variationId ? { ...l, quantity } : l)).filter((l) => l.quantity > 0));
}
export const clearCart = () => save([]);
export const cartCount = () => getCart().reduce((n, l) => n + l.quantity, 0);
export const money = (cents, cur = "USD") => new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(cents / 100);
