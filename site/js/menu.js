// The nav dropdowns are <details> elements, so they already open by tap, click or keyboard. This
// adds what menus are expected to do: one open at a time, and close on Escape (focus returns to its
// button), on a click elsewhere, when focus leaves it, or once a link in it is chosen.
const menus = /** @type {HTMLDetailsElement[]} */ ([...document.querySelectorAll("nav details.menu")]);

for (const menu of menus) {
  menu.addEventListener("toggle", () => {
    if (menu.open) for (const other of menus) if (other !== menu) other.open = false;
  });
  menu.addEventListener("click", (e) => {
    if (/** @type {Element} */ (e.target).closest("a")) menu.open = false;
  });
  menu.addEventListener("focusout", (e) => {
    const next = /** @type {Node | null} */ (e.relatedTarget);
    if (next && !menu.contains(next)) menu.open = false;
  });
}

document.addEventListener("keydown", (e) => {
  const open = menus.find((m) => m.open);
  if (e.key !== "Escape" || !open) return;
  open.open = false;
  open.querySelector("summary").focus();
});

document.addEventListener("click", (e) => {
  for (const menu of menus) if (menu.open && !menu.contains(/** @type {Node} */ (e.target))) menu.open = false;
});
