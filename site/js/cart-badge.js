import { cartCount } from "./cart.js";

const update = () => document.querySelectorAll("[data-cart-count]").forEach((el) => {
  el.textContent = cartCount();
  el.dataset.n = cartCount();
});
update();
document.addEventListener("cart-changed", update);
window.addEventListener("storage", update);
