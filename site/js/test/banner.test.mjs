import "./setup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { syncBanner } from "../banner.js";

function fakeRoot(until) {
  let removed = false;
  const el =
    until === null
      ? null
      : {
          dataset: { until },
          remove() {
            removed = true;
          },
        };
  return {
    root: /** @type {any} */ ({ querySelector: () => el }),
    wasRemoved: () => removed,
  };
}

test("syncBanner removes the banner once data-until has passed, and keeps it before then", () => {
  const until = "2026-10-24T16:00:00-07:00";
  const before = fakeRoot(until);
  syncBanner(before.root, Date.parse("2026-10-24T15:59:59-07:00"));
  assert.equal(before.wasRemoved(), false);

  const at = fakeRoot(until);
  syncBanner(at.root, Date.parse(until));
  assert.equal(at.wasRemoved(), true);

  const invalid = fakeRoot("not-a-date");
  syncBanner(invalid.root, Date.parse("2099-01-01T00:00:00Z"));
  assert.equal(invalid.wasRemoved(), false);
});
