// A stand-in for the shop's API, installed per test with page.route. It also checks what the real
// API requires: POST bodies must carry their SHA-256 in x-amz-content-sha256 (CloudFront-signed
// Lambda URLs reject anything else).
import { createHash } from "node:crypto";

export const item = (id, name, price, stock, extra = {}) => ({
  id: `item-${id}`,
  name,
  description: extra.description ?? "",
  image: null,
  variations: [{ id, name: "Regular", price, currency: "USD", stock }],
});

export async function mockApi(page, { items = [], taxRate = 0.1, quote, checkout, subscribe } = {}) {
  const calls = { quote: [], checkout: [], subscribe: [], badHash: [] };
  const read = (route) => {
    const req = route.request();
    const body = req.postData() ?? "";
    const want = createHash("sha256").update(body).digest("hex");
    if (req.headers()["x-amz-content-sha256"] !== want) calls.badHash.push(req.url());
    return JSON.parse(body || "{}");
  };
  const priceOf = (id) => items.flatMap((i) => i.variations).find((v) => v.id === id)?.price ?? 0;
  await page.route("**/api/catalog", (route) => route.fulfill({ json: { items } }));
  await page.route("**/api/quote", async (route) => {
    const body = read(route);
    calls.quote.push(body);
    if (quote) return quote(route, body);
    const subtotal = body.lines.reduce((n, l) => n + priceOf(l.variationId) * l.quantity, 0);
    const tax = Math.round(subtotal * taxRate);
    return route.fulfill({ json: { subtotal, shipping: 0, tax, total: subtotal + tax } });
  });
  await page.route("**/api/checkout", async (route) => {
    const body = read(route);
    calls.checkout.push(body);
    return checkout ? checkout(route, body) : route.fulfill({ json: { orderId: "o1", total: body.expectedTotal, status: "COMPLETED" } });
  });
  await page.route("**/api/subscribe", async (route) => {
    calls.subscribe.push(read(route));
    return subscribe ? subscribe(route) : route.fulfill({ json: { ok: true } });
  });
  return calls;
}
