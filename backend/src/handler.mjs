// Lambda handler (Function URL, payload v2) for the shop, routing to the modules:
//   GET  /api/catalog   -> items for sale with live stock (catalog.mjs)
//   POST /api/quote     -> tax and total for a cart; nothing is created (checkout.mjs)
//   POST /api/checkout  -> order + authorise + stock re-check + charge (checkout.mjs)
//   POST /api/subscribe -> email signup into the Square customer directory (subscribe.mjs)
// Each function serves only the routes in ROUTES (the template gives checkout its own function).
import { SquareError } from "square";
import { respond, clientIp } from "./http.mjs";
import { loadCatalog } from "./catalog.mjs";
import { quote, checkout, declineMessage } from "./checkout.mjs";
import { subscribe, _resetLimits as resetSubscribeLimits } from "./subscribe.mjs";
import { _resetSales } from "./stock.mjs";

const routes = new Set((process.env.ROUTES ?? "catalog,quote,subscribe,checkout").split(",").map((r) => r.trim()));

export async function handler(event) {
  const method = event.requestContext?.http?.method ?? event.httpMethod;
  const path = event.rawPath ?? event.path;
  const route = path?.startsWith("/api/") ? path.slice(5) : "";
  try {
    if (method === "OPTIONS") return respond(204, "");
    if (route && !routes.has(route)) return respond(404, { errors: ["Not found"] });
    if (method === "GET" && path === "/api/catalog")
      return respond(200, { items: await loadCatalog() }, { "cache-control": "public, max-age=15" });
    if (method === "POST" && path === "/api/quote") return await quote(JSON.parse(event.body ?? "{}"));
    if (method === "POST" && path === "/api/checkout") return await checkout(JSON.parse(event.body ?? "{}"));
    if (method === "POST" && path === "/api/subscribe") return await subscribe(JSON.parse(event.body ?? "{}"), clientIp(event));
    return respond(404, { errors: ["Not found"] });
  } catch (err) {
    if (err instanceof SquareError) {
      // Card problems are shown in plain words; anything else stays in the logs.
      const msgs = [...new Set((err.errors ?? []).filter((e) => e.category === "PAYMENT_METHOD_ERROR").map((e) => declineMessage(e.code)))];
      console.error("Square error", err.statusCode, JSON.stringify(err.errors));
      const fallback =
        path === "/api/subscribe"
          ? "Couldn't sign you up right now. Please try again later."
          : path === "/api/quote"
            ? "Couldn't look up tax right now."
            : "Payment could not be completed.";
      return respond(msgs.length ? 402 : 502, { errors: msgs.length ? msgs : [fallback] });
    }
    console.error("UNHANDLED", err);
    return respond(err instanceof SyntaxError ? 400 : 500, { errors: ["Something went wrong."] });
  }
}

// For tests: one place to reset per-instance memory.
export function _resetLimits() {
  resetSubscribeLimits();
  _resetSales();
}
export { _setSquare } from "./config.mjs";
export { clientIp } from "./http.mjs";
export { stockOf, soldLines, recordSale, applyRecentSales } from "./stock.mjs";
export { cleanNote, declineMessage } from "./checkout.mjs";
