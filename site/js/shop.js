import { config } from "./config.js";
import { addToCart, getCart, setQuantity, clearCart, money } from "./cart.js";
import "./cart-badge.js";

const $ = (s) => document.querySelector(s);
const form = $("#checkout");
const statusEl = $("#status");
const payBtn = $("#pay");

const api = (path, init) => fetch(`${config.apiBase}${path}`, init);
const say = (text, kind) => { statusEl.className = text ? `msg ${kind}` : ""; statusEl.textContent = text; };

async function renderProducts() {
  const box = $("#products");
  try {
    const res = await api("/api/catalog");
    if (!res.ok) throw new Error();
    const { items } = await res.json();
    if (!items.length) { box.innerHTML = '<p class="empty">Nothing is listed right now. Check back soon!</p>'; return; }
    box.replaceChildren(...items.map(productCard));
  } catch {
    box.innerHTML = '<p class="empty">The shop is unavailable right now. Please try again later.</p>';
  }
}

function productCard(item) {
  const card = document.createElement("article");
  card.className = "card";
  const media = item.image
    ? Object.assign(document.createElement("img"), { src: item.image, alt: item.name, loading: "lazy", decoding: "async" })
    : Object.assign(document.createElement("div"), { className: "ph" });
  const body = document.createElement("div");
  body.className = "card-body";
  const h = document.createElement("h3"); h.textContent = item.name;
  const p = document.createElement("p"); p.textContent = item.description;

  const sel = document.createElement("select");
  sel.setAttribute("aria-label", `Option for ${item.name}`);
  for (const v of item.variations) sel.add(new Option(`${v.name} · ${money(v.price, v.currency)}`, v.id));
  sel.hidden = item.variations.length < 2;

  const price = document.createElement("span"); price.className = "price";
  const btn = Object.assign(document.createElement("button"), { className: "btn", textContent: "Add to cart", type: "button" });
  const sync = () => { price.textContent = money(item.variations.find((v) => v.id === sel.value).price); };
  sel.addEventListener("change", sync); sync();
  btn.addEventListener("click", () => {
    const v = item.variations.find((x) => x.id === sel.value);
    addToCart({ variationId: v.id, itemName: item.name, variationName: item.variations.length > 1 ? v.name : "", price: v.price });
  });

  const row = document.createElement("div"); row.className = "row"; row.append(price, btn);
  body.append(h, p, sel, row);
  card.append(media, body);
  return card;
}

const isShipping = () => form.fulfillment.value === "shipping";
const subtotal = () => getCart().reduce((n, l) => n + l.price * l.quantity, 0);

function renderCart() {
  const cart = getCart();
  const box = $("#cart-lines");
  form.hidden = !cart.length;
  if (cart.length) startSquare();
  if (!cart.length) { box.innerHTML = '<p class="empty">Your cart is empty.</p>'; return; }

  box.replaceChildren(...cart.map((l) => {
    const row = document.createElement("div"); row.className = "cart-line";
    const label = document.createElement("div");
    label.textContent = l.itemName;
    if (l.variationName) { const s = document.createElement("small"); s.textContent = l.variationName; label.append(s); }
    const qty = document.createElement("div"); qty.className = "qty";
    const mk = (t, aria, q) => { const b = Object.assign(document.createElement("button"), { type: "button", textContent: t }); b.setAttribute("aria-label", `${aria} ${l.itemName}`); b.onclick = () => setQuantity(l.variationId, q); return b; };
    const n = document.createElement("span"); n.textContent = l.quantity;
    qty.append(mk("−", "Decrease", l.quantity - 1), n, mk("+", "Increase", Math.min(10, l.quantity + 1)));
    const amt = document.createElement("div"); amt.textContent = money(l.price * l.quantity);
    row.append(label, qty, amt);
    return row;
  }));

  const ship = isShipping() ? config.shippingCents : 0;
  $("#t-sub").textContent = money(subtotal());
  $("#t-ship-row").hidden = !(isShipping() && ship > 0);
  $("#t-ship").textContent = money(ship);
  payBtn.textContent = `Pay ${money(subtotal() + ship)} + tax`;
}

form.addEventListener("change", () => { $("#address").hidden = !isShipping(); renderCart(); });
document.addEventListener("cart-changed", renderCart);

// The Square SDK is only downloaded once the visitor has something in the cart.
let card = null;
let squareStarted = false;
function startSquare() {
  if (squareStarted) return;
  squareStarted = true;
  initSquare().catch(() => say("Couldn't load the payment form. Please refresh.", "err"));
}
async function initSquare() {
  if (!config.squareAppId || !config.squareLocationId) { say("Online checkout isn't available yet.", "err"); return; }
  const host = config.squareEnv === "production" ? "web.squarecdn.com" : "sandbox.web.squarecdn.com";
  await new Promise((ok, fail) => document.head.append(Object.assign(document.createElement("script"), { src: `https://${host}/v1/square.js`, onload: ok, onerror: fail })));
  const payments = window.Square.payments(config.squareAppId, config.squareLocationId);
  card = await payments.card();
  await card.attach("#card-container");
  payBtn.disabled = false;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!card) return;
  const f = new FormData(form);
  payBtn.disabled = true; say("Processing…", "ok");
  try {
    const tok = await card.tokenize();
    if (tok.status !== "OK") throw new Error(tok.errors?.map((x) => x.message).join(" ") || "Card details look incorrect.");
    const body = {
      sourceId: tok.token,
      idempotencyKey: (sessionStorage.idem ??= crypto.randomUUID()),
      lines: getCart().map((l) => ({ variationId: l.variationId, quantity: l.quantity })),
      name: f.get("name"), email: f.get("email"), fulfillment: f.get("fulfillment"),
      address: isShipping() ? Object.fromEntries(["line1", "line2", "city", "state", "postalCode"].map((k) => [k, f.get(k)])) : undefined,
    };
    const res = await api("/api/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const out = await res.json();
    if (!res.ok) throw new Error(out.errors?.join(" ") || "Payment failed.");
    clearCart(); delete sessionStorage.idem;
    form.hidden = true;
    $("#cart-lines").innerHTML = "";
    const done = document.createElement("div"); done.className = "msg ok";
    done.append(`Thank you! Your order is confirmed (${money(out.total)}). `);
    if (out.receiptUrl) done.append(Object.assign(document.createElement("a"), { href: out.receiptUrl, textContent: "View receipt" }));
    $("#cart-lines").append(done);
  } catch (err) {
    // A failed attempt may have changed the cart or card, so use a fresh key next time.
    delete sessionStorage.idem;
    say(err.message, "err"); payBtn.disabled = false;
  }
});

renderProducts();
renderCart();
