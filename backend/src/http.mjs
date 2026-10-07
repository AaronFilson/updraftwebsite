// Response helper and request details shared by the routes.
import { ALLOWED_ORIGIN } from "./config.mjs";

export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const respond = (status, body, extra = {}) => ({
  statusCode: status,
  headers: {
    "cache-control": "no-store",
    "content-type": "application/json",
    "access-control-allow-origin": ALLOWED_ORIGIN,
    "access-control-allow-headers": "content-type, x-amz-content-sha256",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    ...extra,
  },
  // Square returns money amounts as BigInt
  body: JSON.stringify(body, (_, v) => (typeof v === "bigint" ? Number(v) : v)),
});

// The visitor's address. Behind CloudFront, sourceIp is CloudFront's own server, so use the
// X-Forwarded-For chain: entries a client sends come first and can be faked, CloudFront appends the
// real viewer, and the Function URL may append CloudFront. Take the last entry that isn't sourceIp.
export function clientIp(event) {
  const source = event.requestContext?.http?.sourceIp ?? "unknown";
  const chain = String(event.headers?.["x-forwarded-for"] ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  while (chain.length && chain.at(-1) === source) chain.pop();
  return chain.at(-1) ?? source;
}
