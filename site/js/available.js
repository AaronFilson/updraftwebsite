// Home page "Available now": the first few pieces still for sale, each linking to its card in the
// shop. If the shop can't be reached the section stays hidden; the hero's Shop button still works.
import { getJson } from "./api.js";
import { money } from "./cart.js";
import { availableNow, fromPrice } from "./shop-logic.js";

const SHOW = 4;
const section = document.getElementById("available");
const list = document.getElementById("available-list");

/** @param {import("./shop-logic.js").Item} item */
function card(item) {
  const a = Object.assign(document.createElement("a"), { className: "card product-link", href: `/shop.html#p-${item.id}` });
  a.append(
    item.image
      ? Object.assign(document.createElement("img"), { src: item.image, alt: "", loading: "lazy", decoding: "async" })
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

async function load() {
  try {
    const res = await getJson("/api/catalog");
    if (!res.ok) return;
    const { items } = await res.json();
    if (!items.length) return; // nothing listed at all: leave the section out
    const pieces = availableNow(items, SHOW);
    if (pieces.length) list.replaceChildren(...pieces.map(card));
    else
      list.innerHTML =
        '<p class="empty">Everything in the shop has sold for now. <a href="#signup">Get a first look at the next pieces</a>.</p>';
    section.hidden = false;
  } catch {
    // network trouble: stay hidden
  }
}
load();
