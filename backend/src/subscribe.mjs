// POST /api/subscribe: adds an email to the Square customer directory (and newsletter group, if set).
import { createHash } from "node:crypto";
import { NEWSLETTER_GROUP_ID, square } from "./config.mjs";
import { respond, EMAIL_RE } from "./http.mjs";

// Best-effort abuse limits, per warm Lambda instance (the template also caps concurrency):
// at most 5 signup attempts per IP per 10 minutes, and a repeat of the same email within an hour is a no-op.
const IP_WINDOW_MS = 10 * 60_000;
const IP_MAX = 5;
const EMAIL_WINDOW_MS = 60 * 60_000;
const ipHits = new Map();
const recentEmails = new Map();
const prune = (map, now, ttl) => {
  for (const [k, v] of map) if (now - (v.at ?? v) > ttl) map.delete(k);
};
export function _resetLimits() {
  ipHits.clear();
  recentEmails.clear();
} // for tests

function overLimit(ip, now = Date.now()) {
  prune(ipHits, now, IP_WINDOW_MS);
  const hit = ipHits.get(ip) ?? { at: now, n: 0 };
  hit.n += 1;
  ipHits.set(ip, hit);
  return hit.n > IP_MAX;
}

// Same response whether or not the address was already known, so the form can't be used to probe the list.
export async function subscribe(b, ip = "unknown") {
  if (b.website) return respond(200, { ok: true }); // spam trap field, filled only by bots
  if (overLimit(ip)) return respond(429, { errors: ["Too many attempts. Please try again in a few minutes."] });
  const email = String(b.email ?? "")
    .trim()
    .toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) return respond(400, { errors: ["Enter a valid email address."] });
  const now = Date.now();
  prune(recentEmails, now, EMAIL_WINDOW_MS);
  if (recentEmails.has(email)) return respond(200, { ok: true });

  const { customers = [] } = await square().customers.search({
    limit: BigInt(1),
    query: { filter: { emailAddress: { exact: email } } },
  });
  let id = customers[0]?.id;
  if (!id) {
    const { customer } = await square().customers.create({
      idempotencyKey: `s-${createHash("sha256").update(email).digest("hex").slice(0, 40)}`,
      emailAddress: email,
      note: "Signed up for email updates on the website",
    });
    id = customer.id;
  }
  if (NEWSLETTER_GROUP_ID) await square().customers.groups.add({ customerId: id, groupId: NEWSLETTER_GROUP_ID });
  recentEmails.set(email, now);
  return respond(200, { ok: true });
}
