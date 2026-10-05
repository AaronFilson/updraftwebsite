import "./cart-badge.js";

// Lightbox: links point at the large image, so this works (as a plain link) without JS too.
// The full-size JPEG is never fetched unless the visitor clicks "Full size".
const dialog = document.createElement("dialog");
dialog.className = "lightbox";
dialog.innerHTML = '<form method="dialog"><button aria-label="Close">×</button></form><img alt=""><p><span></span> <a target="_blank" rel="noopener"></a></p>';
document.body.append(dialog);
const big = dialog.querySelector("img");
const title = dialog.querySelector("span");
const fullLink = dialog.querySelector("p a");

document.addEventListener("click", (e) => {
  const a = e.target.closest("a.zoom");
  if (!a || e.metaKey || e.ctrlKey) return;
  e.preventDefault();
  big.src = a.href;
  big.alt = a.dataset.alt;
  title.textContent = a.dataset.title;
  fullLink.hidden = !a.dataset.full;
  if (a.dataset.full) {
    fullLink.href = a.dataset.full;
    fullLink.textContent = `Full size (JPG, ${a.dataset.fullSize})`;
  }
  dialog.showModal();
});
dialog.addEventListener("click", (e) => { if (e.target === dialog || e.target === big) dialog.close(); });
dialog.addEventListener("close", () => big.removeAttribute("src"));
