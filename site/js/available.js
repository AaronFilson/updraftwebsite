// Home page "Available now": the first few pieces still for sale, each linking to its card in the
// shop. If the shop can't be reached the section is hidden; the hero's Shop button still works.
import { getJson } from "./api.js";
import { money } from "./cart.js";
import { availableNow, fromPrice } from "./shop-logic.js";
import { picture } from "./photos.js";

const SHOW = 4;
const section = document.getElementById("available");
const list = document.getElementById("available-list");

/** @param {import("./shop-logic.js").Item} item */
function card(item) {
  const a = Object.assign(document.createElement("a"), { className: "card product-link", href: `/shop.html#p-${item.id}` });
  a.append(
    item.image
      ? picture(item.image, { sizes: "(max-width: 599px) 46vw, 260px" })
      : Object.assign(document.createElement("div"), { className: "ph" }),
  );
  const body = Object.assign(document.createElement("div"), { className: "card-body" });
  const { price, varies } = fromPrice(item);
  body.append(
    Object.assign(document.createElement("h3"), { textContent: item.name }),
    Object.assign(document.createElement("span"), { className: "price", textContent: `${varies ? "From " : ""}${money(price)}` }),
  );
  a.append(body);
  return a;
}

// The page ships placeholder cards in the strip (index.html) so nothing below it jumps; these replace them.
async function load() {
  try {
    const res = await getJson("/api/catalog");
    const { items } = res.ok ? await res.json() : { items: [] };
    if (!items.length) {
      section.hidden = true; // nothing listed, or the shop can't be reached: leave the section out
      return;
    }
    const pieces = availableNow(items, SHOW);
    if (pieces.length) list.replaceChildren(...pieces.map(card));
    else
      list.innerHTML =
        '<p class="empty">Everything in the shop has sold for now. <a href="#signup">Get a first look at the next pieces</a>.</p>';
  } catch {
    section.hidden = true; // network trouble
  } finally {
    section.removeAttribute("aria-busy");
  }
}
load();
