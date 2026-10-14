// Email signup against a fake Square customer directory (no network).
import test from "node:test";
import assert from "node:assert/strict";
import { handler, _setSquare, _resetLimits } from "../src/handler.mjs";

// Like Square: a customer can be deleted, and an idempotency key can't be reused with different data.
function fakeDirectory() {
  const people = new Map(),
    keys = new Map();
  let n = 0;
  return {
    people,
    customers: {
      search: async ({ query }) => ({
        customers: [...people.values()].filter((c) => c.emailAddress === query.filter.emailAddress.exact),
      }),
      create: async ({ idempotencyKey, ...req }) => {
        if (keys.has(idempotencyKey)) throw new Error("IDEMPOTENCY_KEY_REUSED");
        const customer = { id: `C${++n}`, ...req, groups: [] };
        keys.set(idempotencyKey, customer);
        people.set(customer.id, customer);
        return { customer };
      },
      groups: { add: async ({ customerId, groupId }) => people.get(customerId).groups.push(groupId) },
    },
  };
}

const signUp = (email) =>
  handler({ requestContext: { http: { method: "POST" } }, rawPath: "/api/subscribe", body: JSON.stringify({ email }) });

test("someone deleted from the customer directory can sign up again", async () => {
  const sq = fakeDirectory();
  _setSquare(sq);
  _resetLimits();
  assert.equal((await signUp("Pat@Example.com")).statusCode, 200);
  assert.equal(sq.people.size, 1);
  sq.people.clear(); // deleted in Square Dashboard
  _resetLimits(); // later, on a fresh Lambda instance
  assert.equal((await signUp("pat@example.com")).statusCode, 200);
  assert.deepEqual(
    [...sq.people.values()].map((c) => c.emailAddress),
    ["pat@example.com"],
  );
});

test("signing up twice keeps one customer", async () => {
  const sq = fakeDirectory();
  _setSquare(sq);
  _resetLimits();
  await signUp("lee@example.com");
  _resetLimits();
  assert.equal((await signUp("lee@example.com")).statusCode, 200);
  assert.equal(sq.people.size, 1);
});
