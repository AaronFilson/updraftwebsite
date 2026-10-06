import "./setup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { addToCart, getCart, setQuantity, updateCart, clearCart, cartCount, money } from "../cart.js";

const bowl = { variationId: "bowl", itemName: "Celadon bowl", variationName: "", price: 6500 };
const mug = { variationId: "mug", itemName: "Mug", variationName: "", price: 3000 };

test.beforeEach(() => {
  localStorage.clear();
});

test("a one-of-a-kind piece can only be added once", () => {
  assert.equal(addToCart({ ...bowl, max: 1 }), true);
  assert.equal(addToCart({ ...bowl, max: 1 }), false);
  assert.equal(cartCount(), 1);
});

test("untracked items cap at 10 per line", () => {
  for (let i = 0; i < 12; i++) addToCart(mug);
  assert.equal(getCart()[0].quantity, 10);
});

test("setQuantity respects the stock limit and removes lines at 0", () => {
  addToCart({ ...mug, max: 3 });
  setQuantity("mug", 7);
  assert.equal(getCart()[0].quantity, 3);
  setQuantity("mug", 0);
  assert.deepEqual(getCart(), []);
});

test("every change announces cart-changed", () => {
  let events = 0;
  const on = () => events++;
  document.addEventListener("cart-changed", on);
  addToCart(mug);
  updateCart((lines) => lines);
  clearCart();
  document.removeEventListener("cart-changed", on);
  assert.equal(events, 3);
});

test("a corrupt saved cart reads as empty instead of breaking the page", () => {
  localStorage.setItem("updraft-cart", "{not json");
  assert.deepEqual(getCart(), []);
});

test("money formats cents as US dollars", () => {
  assert.equal(money(4200), "$42.00");
  assert.equal(money(13641), "$136.41");
});
