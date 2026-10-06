import "./setup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { reconcile, goneMessage, removedMessage, subtotal, quoteKey, phoneOk, fieldName } from "../shop-logic.js";

const line = (variationId, quantity, extra = {}) => ({ variationId, itemName: variationId, price: 1000, quantity, ...extra });

test("reconcile drops sold and vanished pieces and caps quantities at stock", () => {
  const stock = new Map([
    ["bowl", { stock: 0, name: "Celadon bowl" }],
    ["mug", { stock: 2, name: "Mug" }],
    ["plate", { stock: null, name: "Plate" }],
  ]);
  const { lines, gone } = reconcile([line("bowl", 1), line("mug", 5), line("plate", 4), line("old", 1, { itemName: "Old jar" })], stock);
  assert.deepEqual(gone, ["Celadon bowl", "Old jar"]);
  assert.deepEqual(
    lines.map((l) => [l.variationId, l.quantity, l.max]),
    [
      ["mug", 2, 2],
      ["plate", 4, undefined],
    ],
  );
});

test("messages read naturally for one and several pieces", () => {
  assert.equal(goneMessage(["Bowl"]), "Bowl has sold and was removed from your cart.");
  assert.equal(goneMessage(["Bowl", "Jar"]), "Bowl and Jar have sold and were removed from your cart.");
  assert.equal(removedMessage("Sorry, Bowl just sold.", 1), "Sorry, Bowl just sold. It was removed from your cart.");
  assert.equal(removedMessage("Sorry, Bowl and Jar just sold.", 2), "Sorry, Bowl and Jar just sold. They were removed from your cart.");
});

test("subtotal and quote key", () => {
  assert.equal(subtotal([line("a", 2), line("b", 1, { price: 4500 })]), 6500);
  assert.equal(quoteKey([line("a", 2)], "pickup"), quoteKey([line("a", 2)], "pickup"));
  assert.notEqual(quoteKey([line("a", 2)], "pickup"), quoteKey([line("a", 2)], "shipping"));
  assert.notEqual(quoteKey([line("a", 2)], "pickup"), quoteKey([line("a", 3)], "pickup"));
});

test("phone is optional, but if given needs 10-15 digits", () => {
  assert.equal(phoneOk(""), true);
  assert.equal(phoneOk("(253) 555-0142"), true);
  assert.equal(phoneOk("+44 20 7946 0958"), true);
  assert.equal(phoneOk("555-0142"), false);
});

test("field names read naturally in error messages", () => {
  assert.equal(fieldName("Full name "), "full name");
  assert.equal(fieldName("ZIP code"), "ZIP code");
  assert.equal(fieldName("State (2 letters, e.g. WA)"), "state");
});
