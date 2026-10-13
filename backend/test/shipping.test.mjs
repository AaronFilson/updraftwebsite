// Shipping prices against the published-rate figures in the shipping plan.
import test from "node:test";
import assert from "node:assert/strict";
import { carrierFor, zoneFor, labelDollars, shippingCents } from "../src/shipping.mjs";

test("zones from Tacoma match the UPS chart for 984", () => {
  for (const [zip, zone] of [
    ["98101", 1],
    ["97201", 2],
    ["83702", 4],
    ["94103", 5],
    ["80202", 6],
    ["60601", 7],
    ["10001", 8],
    ["33101", 8],
  ])
    assert.equal(zoneFor(zip), zone, zip);
  assert.equal(zoneFor("96720"), 8); // Hilo: the chart writes this prefix as "96700"
  assert.equal(zoneFor("00000"), null);
});

test("UPS unless UPS can't deliver there", () => {
  assert.equal(carrierFor({ state: "WA", line1: "1 Main St" }), "ups");
  assert.equal(carrierFor({ state: "wa", line1: "PO Box 12" }), "usps");
  assert.equal(carrierFor({ state: "OR", line1: "1 Main St", line2: "P.O. Box 9" }), "usps");
  for (const state of ["AK", "HI", "PR", "AE"]) assert.equal(carrierFor({ state, line1: "1 Main St" }), "usps", state);
  assert.equal(carrierFor({ state: "WA", line1: "12 Boxwood Ln" }), "ups");
});

test("labels match the planner: 23 lb UPS is about $35 near and $72 far", () => {
  assert.equal(Math.round(labelDollars("ups", 2, 23)), 35);
  assert.equal(Math.round(labelDollars("ups", 8, 23)), 72);
  assert.equal(labelDollars("ups", 1, 23), labelDollars("ups", 2, 23)); // UPS starts at zone 2
  assert.equal(Math.round(labelDollars("usps", 8, 23)), 61);
});

test("one label per piece, summed and rounded up to whole dollars", () => {
  const one = shippingCents([23], { state: "NY", postalCode: "10001", line1: "1 Main St" });
  const two = shippingCents([23, 23], { state: "NY", postalCode: "10001", line1: "1 Main St" });
  assert.equal(one.cents, 7300); // $72.03 rounds up
  assert.equal(two.cents, Math.ceil(2 * labelDollars("ups", 8, 23)) * 100);
  assert.match(shippingCents([5], { state: "WA", postalCode: "00000" }).error, /can't ship to that ZIP/);
});

test("past the rate tables there's no price, only a request to ask", () => {
  assert.equal(labelDollars("ups", 5, 41), null);
  assert.equal(labelDollars("usps", 5, 71), null);
  assert.match(shippingCents([45], { state: "WA", postalCode: "98101", line1: "1 Main St" }).error, /too heavy to price online/);
});
