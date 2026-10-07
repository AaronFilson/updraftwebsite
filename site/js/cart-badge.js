import { cartCount } from "./cart.js";

const update = () =>
  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-cart-count]")).forEach((el) => {
    el.textContent = String(cartCount());
    el.dataset.n = String(cartCount());
  });
update();
document.addEventListener("cart-changed", update);
window.addEventListener("storage", update);
