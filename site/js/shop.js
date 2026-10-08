import { config } from "./config.js";
import { getJson, postJson } from "./api.js";
import {
  reconcile,
  goneMessage,
  removedMessage,
  subtotal as cartSubtotal,
  quoteKey as cartQuoteKey,
  phoneOk,
  fieldName as labelName,
  specLine,
  typeCounts,
  showTypeFilters,
  productData,
} from "./shop-logic.js";
import { picture } from "./photos.js";
import { createPieceView } from "./piece-view.js";
import { addToCart, getCart, setQuantity, updateCart, clearCart, cartCount, lineMax, money } from "./cart.js";
import "./cart-badge.js";
import "./menu.js";
import "./signup.js";

const $ = (s) => document.querySelector(s);
const form = $("#checkout");
const statusEl = $("#status");
const errorEl = $("#error");
const announcer = $("#announce");
const payBtn = $("#pay");

// Progress goes to the polite status region, failures to the assertive alert region.
const say = (text, kind) => {
  const [el, other] = kind === "err" ? [errorEl, statusEl] : [statusEl, errorEl];
  other.className = "";
  other.textContent = "";
  el.className = text ? `msg ${kind}` : "";
  el.textContent = text;
};
// Clearing first makes screen readers re-announce identical messages.
const announce = (text) => {
  announcer.textContent = "";
  setTimeout(() => {
    announcer.textContent = text;
  }, 50);
};
const items = (n) => `${n} ${n === 1 ? "item" : "items"}`;

// ---- products and stock ---------------------------------------------------------------------
// variation id -> { stock: number | null (no limit), name } from the latest catalog.
const stockById = new Map();
const byId = new Map(); // item id -> catalog item
const cardSyncs = new Set(); // every visible "buy" control's refresh (button text, Sold labels)
const inCart = (id) => getCart().find((l) => l.variationId === id)?.quantity ?? 0;
const stock = (v) => stockById.get(v.id)?.stock ?? null;
const soldOut = (item) => item.variations.every((v) => stock(v) === 0);

async function renderProducts() {
  const box = $("#products");
  try {
    const res = await getJson("/api/catalog");
    if (!res.ok) throw new Error();
    const { items } = await res.json();
    for (const item of items) {
      byId.set(item.id, item);
      for (const v of item.variations)
        stockById.set(v.id, { stock: v.stock ?? null, name: item.variations.length > 1 ? `${item.name} (${v.name})` : item.name });
    }
    reconcileCart();
    if (!items.length) {
      box.innerHTML = '<p class="empty">Nothing is listed right now. Check back soon!</p>';
      return;
    }
    box.replaceChildren(...items.map(productCard));
    renderFilters(items);
    // Search engines read prices and availability from this (a data block, so the CSP doesn't apply).
    const data = Object.assign(document.createElement("script"), { type: "application/ld+json" });
    data.textContent = JSON.stringify(productData(items, location.origin));
    document.head.append(data);
    openFromHash(); // a link to one piece: /shop.html#p-ITEM
  } catch {
    box.innerHTML = '<p class="empty">The shop is unavailable right now. Please try again later.</p>';
  } finally {
    box.setAttribute("aria-busy", "false");
  }
}

// Show (and announce) why something left the cart.
function notice(text) {
  const el = $("#cart-notice");
  el.textContent = text;
  el.hidden = !text;
  if (text) announce(text);
}

// Drop sold pieces from a cart saved earlier, and refresh each line's stock limit.
function reconcileCart() {
  let gone = [];
  updateCart((lines) => {
    const out = reconcile(lines, stockById);
    gone = out.gone;
    return out.lines;
  });
  if (gone.length) notice(goneMessage(gone));
}

// Called when the server says pieces just sold (from the tax lookup or at checkout).
function markSold(ids, message) {
  for (const id of ids) {
    const s = stockById.get(id);
    if (s) s.stock = 0;
  }
  for (const sync of cardSyncs) sync();
  updateCart((lines) => lines.filter((l) => !ids.includes(l.variationId)));
  notice(removedMessage(message, ids.length));
}

// Option picker, price and Add to cart for one piece: on its card and in its detail view.
// onSync(sold) lets the card show its Sold badge.
function buyControls(item, onSync = (_sold) => {}) {
  const sel = document.createElement("select");
  sel.setAttribute("aria-label", `Option for ${item.name}`);
  for (const v of item.variations) sel.add(new Option(`${v.name} · ${money(v.price, v.currency)}`, v.id));
  sel.hidden = item.variations.length < 2;
  const price = Object.assign(document.createElement("span"), { className: "price" });
  const btn = Object.assign(document.createElement("button"), { className: "btn", type: "button" });
  const selected = () => item.variations.find((v) => v.id === sel.value);
  // Button reads Add to cart / In cart (one-of-a-kind already added) / Sold.
  const sync = () => {
    const v = selected();
    const left = stock(v);
    for (const [n, opt] of [...sel.options].entries()) {
      const vv = item.variations[n];
      opt.textContent = `${vv.name} · ${money(vv.price, vv.currency)}${stock(vv) === 0 ? " · Sold" : ""}`;
    }
    price.textContent = money(v.price);
    const full = left !== null && inCart(v.id) >= left;
    btn.disabled = left === 0 || full;
    btn.textContent = left === 0 ? "Sold" : full ? "In cart" : "Add to cart";
    btn.setAttribute(
      "aria-label",
      left === 0 ? `${item.name} is sold` : full ? `${item.name} is in your cart` : `Add ${item.name} to cart`,
    );
    onSync(soldOut(item));
  };
  cardSyncs.add(sync);
  sel.addEventListener("change", sync);
  btn.addEventListener("click", () => {
    const v = selected();
    notice("");
    const added = addToCart({
      variationId: v.id,
      itemName: item.name,
      variationName: item.variations.length > 1 ? v.name : "",
      price: v.price,
      max: stock(v) ?? undefined,
    });
    announce(added ? `Added ${item.name} to cart. Cart has ${items(cartCount())}.` : `${item.name} is already in your cart.`);
  });
  sync();
  const row = Object.assign(document.createElement("div"), { className: "row" });
  row.append(price, btn);
  return { sel, row, dispose: () => cardSyncs.delete(sync) };
}

function productCard(item) {
  const card = document.createElement("article");
  card.className = "card";
  card.id = `p-${item.id}`;
  card.dataset.type = item.category ?? "";
  const href = `#p-${item.id}`;
  // The photo and the name both open the piece's detail view; only the name is a tab stop.
  const media = Object.assign(document.createElement("a"), { className: "media", href, tabIndex: -1 });
  media.setAttribute("aria-hidden", "true");
  media.append(
    item.image
      ? picture(item.image, { sizes: "(max-width: 599px) 46vw, 300px" })
      : Object.assign(document.createElement("div"), { className: "ph" }),
  );
  const soldBadge = Object.assign(document.createElement("span"), { className: "sold-badge", textContent: "Sold" });
  media.append(soldBadge);
  const body = Object.assign(document.createElement("div"), { className: "card-body" });
  const h = document.createElement("h3");
  h.append(Object.assign(document.createElement("a"), { href, textContent: item.name }));
  const spec = Object.assign(document.createElement("p"), { className: "spec", textContent: specLine(item.description) });
  const { sel, row } = buyControls(item, (sold) => {
    card.classList.toggle("is-sold", sold);
    soldBadge.hidden = !sold;
  });
  body.append(h, ...(spec.textContent ? [spec] : []), sel, row);
  card.append(media, body);
  return card;
}
document.addEventListener("cart-changed", () => {
  for (const sync of cardSyncs) sync();
});

// ---- detail view, opened by #p-ITEM ----------------------------------------------------------
// Opening from a click on this page adds a history entry (so Back closes it); arriving with the hash
// (from the home page or a shared link) doesn't, so closing then just clears the hash.
let pushed = false;
const view = createPieceView({
  buyControls,
  onClose: (item) => {
    if (pushed) history.back();
    else if (location.hash.startsWith("#p-")) history.replaceState(null, "", location.pathname + location.search);
    pushed = false;
    // Back to the piece's name, unless focus already moved somewhere else on the page. Safari never
    // focuses a clicked link, so there the browser has nothing of its own to restore.
    setTimeout(() => {
      const card = item && document.getElementById(`p-${item.id}`);
      const now = document.activeElement;
      if (card && (!now || now === document.body || now.closest("dialog.piece")))
        /** @type {HTMLElement} */ (card.querySelector("h3 a")).focus();
    });
  },
});
function openFromHash(fromClick = false) {
  const id = location.hash.startsWith("#p-") ? decodeURIComponent(location.hash.slice(3)) : "";
  const item = byId.get(id);
  if (item) {
    pushed = fromClick;
    view.open(item);
  } else if (view.isOpen()) {
    pushed = false; // the hash is already gone (Back was pressed)
    view.close();
  }
}
window.addEventListener("hashchange", () => openFromHash(true));

// ---- browse by type (Square categories), once there are enough pieces ------------------------
function renderFilters(list) {
  const bar = $("#filters");
  if (!showTypeFilters(list)) return;
  const want = new URLSearchParams(location.search).get("type") ?? "";
  const types = typeCounts(list);
  let current = types.some((t) => t.name === want) ? want : "";
  const options = [{ name: "", label: `All (${list.length})` }, ...types.map((t) => ({ name: t.name, label: `${t.name} (${t.count})` }))];
  const buttons = options.map((o) => {
    const b = Object.assign(document.createElement("button"), { type: "button", className: "chip", textContent: o.label });
    b.addEventListener("click", () => {
      current = o.name;
      apply();
      const shown = [.../** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("#products .card"))].filter(
        (c) => !c.hidden,
      ).length;
      announce(`Showing ${shown} ${shown === 1 ? "piece" : "pieces"}${current ? ` in ${current}` : ""}.`);
    });
    return b;
  });
  function apply() {
    for (const c of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("#products .card")))
      c.hidden = Boolean(current) && c.dataset.type !== current;
    options.forEach((o, n) => buttons[n].setAttribute("aria-pressed", String(o.name === current)));
    const url = new URL(location.href);
    if (current) url.searchParams.set("type", current);
    else url.searchParams.delete("type");
    history.replaceState(history.state, "", url); // shareable, without adding history entries
  }
  bar.replaceChildren(...buttons);
  bar.hidden = false;
  apply();
}

const isShipping = () => form.fulfillment.value === "shipping";
const shipSeparately = () => isShipping() && !form.shipSame.checked;
const subtotal = () => cartSubtotal(getCart());

function renderCart() {
  const cart = getCart();
  const box = $("#cart-lines");
  // Rows are rebuilt on every change, so remember which qty button had focus and restore it afterwards.
  const active = /** @type {HTMLElement | null} */ (document.activeElement?.closest?.("#cart-lines button"));
  const focusAt = active && {
    id: active.dataset.id,
    act: active.dataset.act,
    index: [...box.querySelectorAll(".cart-line")].indexOf(active.closest(".cart-line")),
  };

  form.hidden = !cart.length;
  if (cart.length) startSquare();
  if (!cart.length) {
    box.innerHTML = '<p class="empty">Your cart is empty.</p>';
    if (focusAt) $("#cart-title").focus();
    return;
  }

  box.replaceChildren(
    ...cart.map((l) => {
      const row = document.createElement("div");
      row.className = "cart-line";
      const label = document.createElement("div");
      label.textContent = l.itemName;
      if (l.variationName) {
        const s = document.createElement("small");
        s.textContent = l.variationName;
        label.append(s);
      }
      const name = [l.itemName, l.variationName].filter(Boolean).join(", ");
      const qty = document.createElement("div");
      qty.className = "qty";
      const mk = (t, act, q) => {
        const b = Object.assign(document.createElement("button"), { type: "button", textContent: t });
        b.dataset.id = l.variationId;
        b.dataset.act = act;
        b.setAttribute("aria-label", `${act === "dec" ? "Decrease" : "Increase"} quantity of ${name}`);
        b.onclick = () => {
          setQuantity(l.variationId, q);
          announce(q > 0 ? `${name}: quantity ${q}` : `${name} removed from cart`);
        };
        return b;
      };
      if (lineMax(l) === 1) {
        // One-of-a-kind: nothing to count, just a way to take it out.
        const rm = Object.assign(document.createElement("button"), { type: "button", textContent: "Remove", className: "link-btn" });
        rm.dataset.id = l.variationId;
        rm.dataset.act = "remove";
        rm.setAttribute("aria-label", `Remove ${name} from cart`);
        rm.onclick = () => {
          setQuantity(l.variationId, 0);
          announce(`${name} removed from cart`);
        };
        qty.append(rm);
      } else {
        const n = document.createElement("span");
        n.textContent = l.quantity;
        n.setAttribute("aria-label", `Quantity ${l.quantity}`);
        const plus = mk("+", "inc", l.quantity + 1);
        plus.disabled = l.quantity >= lineMax(l);
        qty.append(mk("−", "dec", l.quantity - 1), n, plus);
      }
      const amt = document.createElement("div");
      amt.textContent = money(l.price * l.quantity);
      row.append(label, qty, amt);
      return row;
    }),
  );

  if (focusAt) {
    const same = box.querySelector(`button[data-id="${CSS.escape(focusAt.id)}"][data-act="${focusAt.act}"]`);
    // If that line was removed, move to the line that took its place (or the last one).
    const rows = box.querySelectorAll(".cart-line");
    (same ?? rows[Math.min(focusAt.index, rows.length - 1)]?.querySelector("button"))?.focus();
  }

  const ship = isShipping() ? config.shippingCents : 0;
  $("#t-sub").textContent = money(subtotal());
  $("#t-ship-row").hidden = !(isShipping() && ship > 0);
  $("#t-ship").textContent = money(ship);
  requestQuote();
}

// Billing is always required; the shipping section shows only for shipping, and its fields only
// when the customer unticks "Ship to my billing address".
function syncAddressSections() {
  $("#shipping").hidden = !isShipping();
  $("#pickup-info").hidden = isShipping();
  $("#note-hint").textContent = isShipping()
    ? "Gift message, delivery notes, or anything else I should know"
    : "How to reach you to schedule pickup, or anything else I should know";
  $("#ship-fields").hidden = !shipSeparately();
  for (const input of form.querySelectorAll("[data-ship]")) input.required = shipSeparately();
}
form.addEventListener("change", (e) => {
  if (e.target.name === "fulfillment") {
    syncAddressSections();
    renderCart();
  }
  if (e.target.name === "shipSame") syncAddressSections();
  // Carry the billing ZIP into Square's card form, which asks for one itself.
  if (e.target.name === "billZip" && card && /^\d{5}$/.test(e.target.value.trim())) {
    try {
      card.configure({ postalCode: e.target.value.trim() });
    } catch {
      /* older SDK: buyer types it */
    }
  }
});
document.addEventListener("cart-changed", renderCart);

// ---- tax and total, looked up from Square before paying ----------------------------------
let quote = null; // { key, subtotal, shipping, tax, total } for the current cart, or null
let quoting = false;
let quoteSeq = 0;
let quoteTimer = null;
let cardReady = false;
const quoteKey = () => cartQuoteKey(getCart(), form.fulfillment.value);

function updatePayButton() {
  payBtn.disabled = !cardReady || quoting;
  const fallback = subtotal() + (isShipping() ? config.shippingCents : 0);
  payBtn.textContent = quoting ? "Looking up tax…" : quote ? `Pay ${money(quote.total)}` : `Pay ${money(fallback)} + tax`;
}

function showQuote(state, q) {
  const tax = $("#t-tax"),
    total = $("#t-total"),
    note = $("#quote-status");
  for (const el of [tax, total]) el.setAttribute("aria-busy", String(state === "loading"));
  if (state === "loading") {
    tax.textContent = "…";
    total.textContent = "…";
    note.textContent = "Looking up sales tax…";
  } else if (state === "ok") {
    tax.textContent = money(q.tax);
    total.textContent = money(q.total);
    if (q.shipping) $("#t-ship").textContent = money(q.shipping);
    note.textContent = `Sales tax ${money(q.tax)}. Total ${money(q.total)}.`;
  } else {
    tax.textContent = "–";
    total.textContent = "–";
    note.textContent = "Couldn't look up sales tax right now. It will be added when you pay.";
  }
  updatePayButton();
}

function requestQuote() {
  if (!getCart().length) return;
  const key = quoteKey();
  if (quote?.key === key) return showQuote("ok", quote);
  quote = null;
  quoting = true;
  showQuote("loading");
  clearTimeout(quoteTimer);
  // Short debounce so clicking + several times sends one request.
  quoteTimer = setTimeout(async () => {
    const seq = ++quoteSeq;
    try {
      const res = await postJson("/api/quote", {
        lines: getCart().map((l) => ({ variationId: l.variationId, quantity: l.quantity })),
        fulfillment: form.fulfillment.value,
      });
      const out = await res.json();
      if (seq !== quoteSeq) return; // a newer cart change is already being looked up
      if (res.status === 409 && out.sold) {
        quoting = false;
        markSold(out.sold, out.errors[0]);
        return;
      }
      if (!res.ok) throw new Error(out.errors?.[0]);
      quote = { key, ...out };
      quoting = false;
      showQuote("ok", quote);
    } catch {
      if (seq !== quoteSeq) return;
      quoting = false;
      showQuote("error");
    }
  }, 250);
}

// Validation: messages sit next to each field and are linked with aria-describedby.
// "ZIP code" -> "ZIP code", "Full name" -> "full name"
const fieldName = (input) => labelName(input.closest("label").firstChild.textContent);
function clearError(input) {
  input.removeAttribute("aria-invalid");
  input.removeAttribute("aria-describedby");
  input.closest("label").querySelector(".field-err")?.remove();
}
function validate() {
  let first = null;
  for (const input of form.querySelectorAll("label.field input")) {
    clearError(input);
    if (input.closest("[hidden]")) continue; // e.g. shipping fields while shipping to the billing address
    input.value = input.value.trim();
    if (input.name === "phone") input.setCustomValidity(phoneOk(input.value) ? "" : "bad");
    if (input.checkValidity()) continue;
    const msg = document.createElement("span");
    msg.className = "field-err";
    msg.id = `err-${input.name}`;
    msg.textContent = input.validity.valueMissing ? `Enter your ${fieldName(input)}.` : `Check your ${fieldName(input)}.`;
    input.closest("label").append(msg);
    input.setAttribute("aria-invalid", "true");
    input.setAttribute("aria-describedby", msg.id);
    first ??= input;
  }
  if (first) {
    say("Please fix the highlighted fields.", "err");
    first.focus();
  }
  return !first;
}
form.addEventListener("input", (e) => {
  if (e.target.getAttribute("aria-invalid")) clearError(e.target);
  if (e.target.name === "note") $("#note-count").textContent = `${e.target.value.length} of 500 characters`;
});

// The idempotency key survives a reload mid-payment; fall back to memory if storage is blocked.
let idemMemory = null;
const idemKey = () => {
  try {
    return (sessionStorage.idem ??= crypto.randomUUID());
  } catch {
    return (idemMemory ??= crypto.randomUUID());
  }
};
const resetIdem = () => {
  idemMemory = null;
  try {
    delete sessionStorage.idem;
  } catch {
    /* storage blocked */
  }
};

// The Square SDK is only downloaded once the visitor has something in the cart.
let card = null;
let squareStarted = false;
function startSquare() {
  if (squareStarted) return;
  squareStarted = true;
  initSquare().catch(() => say("Couldn't load the payment form. Please refresh.", "err"));
}
async function initSquare() {
  if (!config.squareAppId || !config.squareLocationId) {
    say("Online checkout isn't available yet.", "err");
    return;
  }
  const host = config.squareEnv === "production" ? "web.squarecdn.com" : "sandbox.web.squarecdn.com";
  await new Promise((ok, fail) =>
    document.head.append(
      Object.assign(document.createElement("script"), { src: `https://${host}/v1/square.js`, onload: ok, onerror: fail }),
    ),
  );
  const payments = window.Square.payments(config.squareAppId, config.squareLocationId);
  card = await payments.card();
  const zip = form.billZip.value.trim();
  await card.attach("#card-container", /^\d{5}$/.test(zip) ? { postalCode: zip } : undefined);
  cardReady = true;
  updatePayButton();
}

const address = (f, p) => ({
  line1: f.get(`${p}Line1`),
  line2: f.get(`${p}Line2`),
  city: f.get(`${p}City`),
  state: f.get(`${p}State`),
  postalCode: f.get(`${p}Zip`),
});

// Checkout handles one order at a time; if another is finishing, the request is turned away with
// HTTP 429 before anything runs, so it is safe to wait a moment and send it again.
async function postCheckout(body) {
  for (let attempt = 1; ; attempt++) {
    const res = await postJson("/api/checkout", body);
    if (res.status !== 429 || attempt >= 10) return res;
    say("Finishing another order, one moment…", "ok");
    await new Promise((ok) => setTimeout(ok, 800 + attempt * 400 + Math.random() * 400));
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!card || quoting || !validate()) return;
  const f = new FormData(form);
  const billing = address(f, "bill");
  const [givenName, ...rest] = String(f.get("name")).trim().split(/\s+/);
  const amount = quote?.total ?? subtotal() + (isShipping() ? config.shippingCents : 0);
  payBtn.disabled = true;
  say("Processing…", "ok");
  try {
    // The billing contact lets Square run its card checks (3-D Secure) with fewer false declines.
    const tok = await card.tokenize({
      amount: (amount / 100).toFixed(2),
      currencyCode: "USD",
      intent: "CHARGE",
      customerInitiated: true,
      sellerKeyedIn: false,
      billingContact: {
        givenName,
        familyName: rest.join(" ") || undefined,
        email: f.get("email"),
        phone: f.get("phone") || undefined,
        addressLines: [billing.line1, billing.line2].filter(Boolean),
        city: billing.city,
        state: billing.state.toUpperCase(),
        postalCode: billing.postalCode,
        countryCode: "US",
      },
    });
    if (tok.status !== "OK") throw new Error(tok.errors?.map((x) => x.message).join(" ") || "Card details look incorrect.");
    const body = {
      sourceId: tok.token,
      idempotencyKey: idemKey(),
      lines: getCart().map((l) => ({ variationId: l.variationId, quantity: l.quantity })),
      name: f.get("name"),
      email: f.get("email"),
      phone: f.get("phone"),
      fulfillment: f.get("fulfillment"),
      note: f.get("note"),
      billing,
      shipping: !isShipping()
        ? undefined
        : shipSeparately()
          ? { name: f.get("shipName"), ...address(f, "ship") }
          : { name: f.get("name"), ...billing },
      expectedTotal: quote?.total,
    };
    const res = await postCheckout(body);
    const out = await res.json();
    if (res.status === 409 && out.sold) {
      // A piece sold while they were paying; the card was not charged.
      resetIdem();
      say("", "ok");
      markSold(out.sold, `${out.errors[0]}${out.notCharged ? " Your card was not charged." : ""}`);
      updatePayButton();
      return;
    }
    if (res.status === 409 && Number.isInteger(out.total)) {
      // Price or tax changed since it was shown: drop the old quote and look it up again.
      quote = null;
      requestQuote();
    }
    if (!res.ok) throw new Error(out.errors?.join(" ") || "Payment failed.");
    // What was just bought is no longer for sale here either (one-of-a-kind pieces show Sold).
    for (const l of getCart()) {
      const s = stockById.get(l.variationId);
      if (s && s.stock !== null) s.stock = Math.max(0, s.stock - l.quantity);
    }
    clearCart();
    resetIdem();
    form.hidden = true;
    $("#cart-lines").innerHTML = "";
    const done = document.createElement("div");
    done.className = "msg ok";
    done.tabIndex = -1;
    done.append(`Thank you! Your order is confirmed (${money(out.total)}). `);
    if (out.receiptUrl) done.append(Object.assign(document.createElement("a"), { href: out.receiptUrl, textContent: "View receipt" }));
    $("#cart-lines").append(done);
    done.focus();
  } catch (err) {
    // A failed attempt may have changed the cart or card, so use a fresh key next time.
    resetIdem();
    say(err.message, "err");
    updatePayButton();
  }
});

syncAddressSections();
// Phones: the cart sits below all the pieces, so once something is in it a bar at the bottom of the
// screen leads there. It hides while the cart is on screen, and on wide screens (cart beside the pieces).
const bar = $("#cart-bar");
const narrow = matchMedia("(max-width: 899px)");
let cartOnScreen = false;
function syncBar() {
  const n = cartCount();
  bar.hidden = !n || cartOnScreen || !narrow.matches;
  $("#cart-bar-count").textContent = items(n);
  $("#cart-bar-total").textContent = money(subtotal());
}
new IntersectionObserver(([e]) => {
  cartOnScreen = e.isIntersecting;
  syncBar();
}).observe($("#cart"));
narrow.addEventListener("change", syncBar);
document.addEventListener("cart-changed", syncBar);
bar.addEventListener("click", (e) => {
  e.preventDefault();
  $("#cart").scrollIntoView({ block: "start" });
  $("#cart-title").focus({ preventScroll: true });
});

renderProducts();
renderCart();
syncBar();
