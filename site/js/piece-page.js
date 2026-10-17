// The page for one piece (/p/ITEM, drawn by the API: backend/src/piece-page.mjs). Its "Buy in the
// shop" link becomes Add to cart here, with the stock as of the page; the shop's cart re-checks it
// against Square before anyone pays. A photo the resizer was too busy to make is asked for again, as
// in the shop (photos.js), before falling back to Square's own.
import { addToCart, getCart, cartCount, money } from "./cart.js";
import { picture, RETRY_MS } from "./photos.js";

/** @typedef {{ id: string, name: string, price: number, currency?: string, stock: number | null }} Variation */
const dataEl = document.getElementById("piece-data");
const piece = /** @type {{ id: string, name: string, variations: Variation[] }} */ (JSON.parse(dataEl?.textContent ?? "null"));
const box = document.getElementById("piece-buy");

// The page's photo failed (the resizer answers 429 past its limit, just after new pieces go up): after
// a wait, swap in the shop's own <picture>, which asks again and then falls back to the original.
function retry(/** @type {HTMLImageElement} */ img) {
  const url = img.dataset.original;
  if (!url) return;
  delete img.dataset.original;
  const widths = [...img.srcset.matchAll(/ (\d+)w/g)].map((m) => Number(m[1]));
  const again = () =>
    img.closest("picture")?.replaceWith(
      picture(url, {
        sizes: img.sizes,
        widths: widths.length ? widths : [800],
        alt: img.alt,
        eager: img.loading !== "lazy",
      }),
    );
  setTimeout(again, RETRY_MS[0] * (0.75 + Math.random() / 2));
}
for (const img of /** @type {NodeListOf<HTMLImageElement>} */ (document.querySelectorAll(".piece-page img[data-original]"))) {
  if (img.complete && img.naturalWidth === 0 && img.currentSrc) retry(img);
  else img.addEventListener("error", () => retry(img), { once: true });
}

const inCart = (/** @type {string} */ id) => getCart().find((l) => l.variationId === id)?.quantity ?? 0;

if (piece && box && piece.variations.some((v) => v.stock !== 0)) {
  const many = piece.variations.length > 1;
  const sel = document.createElement("select");
  sel.setAttribute("aria-label", `Option for ${piece.name}`);
  for (const v of piece.variations) sel.add(new Option(`${v.name} · ${money(v.price, v.currency)}${v.stock === 0 ? " · Sold" : ""}`, v.id));
  const firstOpen = piece.variations.find((v) => v.stock !== 0);
  if (firstOpen) sel.value = firstOpen.id;
  sel.hidden = !many;
  const price = Object.assign(document.createElement("span"), { className: "price" });
  const btn = Object.assign(document.createElement("button"), { className: "btn", type: "button" });
  const row = Object.assign(document.createElement("div"), { className: "row" });
  row.append(price, btn);
  const status = Object.assign(document.createElement("p"), { className: "piece-added" });
  status.setAttribute("role", "status");
  const selected = () => /** @type {Variation} */ (piece.variations.find((v) => v.id === sel.value));

  // Add to cart / In cart (a one-of-a-kind piece already added) / Sold, as on the shop's cards.
  const sync = () => {
    const v = selected();
    const full = v.stock !== null && inCart(v.id) >= v.stock;
    price.textContent = money(v.price, v.currency);
    btn.disabled = v.stock === 0 || full;
    btn.textContent = v.stock === 0 ? "Sold" : full ? "In cart" : "Add to cart";
    btn.setAttribute(
      "aria-label",
      v.stock === 0 ? `${piece.name} is sold` : full ? `${piece.name} is in your cart` : `Add ${piece.name} to cart`,
    );
  };
  sel.addEventListener("change", sync);
  btn.addEventListener("click", () => {
    const v = selected();
    const added = addToCart({
      variationId: v.id,
      itemName: piece.name,
      variationName: many ? v.name : "",
      price: v.price,
      max: v.stock ?? undefined,
    });
    const n = cartCount();
    status.replaceChildren(
      `${added ? "Added to your cart" : "Already in your cart"} (${n} ${n === 1 ? "item" : "items"}). `,
      Object.assign(document.createElement("a"), { href: "/shop.html#cart", textContent: "View cart and check out" }),
    );
  });
  document.addEventListener("cart-changed", sync);
  window.addEventListener("storage", sync); // another tab changed the cart
  sync();
  box.replaceChildren(sel, row, status);
}
