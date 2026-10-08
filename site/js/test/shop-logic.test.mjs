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

test("availableNow keeps pieces with anything left to buy, in order, up to n", async () => {
  const { availableNow, fromPrice } = await import("../shop-logic.js");
  const piece = (id, ...variations) => ({
    id,
    name: id,
    variations: variations.map(([price, stock], i) => ({ id: `${id}${i}`, price, stock })),
  });
  const items = [
    piece("sold", [100, 0]),
    piece("one", [200, 1]),
    piece("open", [300, null]),
    piece("old", [400, undefined]),
    piece("x", [500, 2]),
  ];
  assert.deepEqual(
    availableNow(items, 3).map((i) => i.id),
    ["one", "open", "old"],
  );
  assert.deepEqual(fromPrice(piece("m", [3000, null], [5500, 3], [2000, 0])), { price: 3000, varies: true });
  assert.deepEqual(fromPrice(piece("s", [6500, 1])), { price: 6500, varies: false });
});

test("spec line, the rest of the description, type filters and product data", async () => {
  const { specLine, descriptionRest, typeCounts, showTypeFilters, productData, FILTER_MIN_PIECES } = await import("../shop-logic.js");
  const d = "\n Cone 10 porcelain · celadon \r\nThrown in Tacoma.\n\nSoda fired.";
  assert.equal(specLine(d), "Cone 10 porcelain · celadon");
  assert.deepEqual(descriptionRest(d), ["Thrown in Tacoma.", "Soda fired."]);
  assert.equal(specLine(""), "");
  assert.deepEqual(descriptionRest(""), []);

  const piece = (id, category, stock = 1) => ({
    id,
    name: id,
    category,
    variations: [{ id: `${id}v`, price: 4000, currency: "USD", stock }],
  });
  const few = [piece("a", "Bowls"), piece("b", "Mugs")];
  assert.equal(showTypeFilters(few), false); // too few pieces to need filters
  const many = Array.from({ length: FILTER_MIN_PIECES }, (_, n) => piece(`p${n}`, n % 3 ? "Mugs" : "Bowls"));
  assert.equal(showTypeFilters(many), true);
  assert.equal(showTypeFilters(many.map((p) => ({ ...p, category: "Mugs" }))), false); // one type: nothing to filter
  assert.deepEqual(typeCounts([...many, piece("x", null)]), [
    { name: "Mugs", count: 5 },
    { name: "Bowls", count: 3 },
  ]);

  const data = productData([piece("a", "Bowls"), piece("s", "Mugs", 0)], "https://example.com");
  assert.equal(data.itemListElement.length, 2);
  assert.deepEqual(data.itemListElement[0].item.offers, {
    "@type": "Offer",
    url: "https://example.com/p/a",
    price: "40.00",
    priceCurrency: "USD",
    availability: "https://schema.org/InStock",
  });
  assert.equal(data.itemListElement[1].item.offers.availability, "https://schema.org/SoldOut");
});
