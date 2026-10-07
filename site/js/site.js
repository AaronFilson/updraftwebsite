import "./cart-badge.js";
import "./hero.js";
import "./signup.js";

// Lightbox: links point at the large image, so this works (as a plain link) without JS too.
// The full-size JPEG is never fetched unless the visitor clicks "Full size".
// Previous/next (buttons or arrow keys) step through the gallery the photo belongs to.
const dialog = document.createElement("dialog");
dialog.className = "lightbox";
dialog.setAttribute("aria-labelledby", "lightbox-title");
dialog.innerHTML = `<form method="dialog"><button class="lb-close" aria-label="Close">×</button></form>
<button class="lb-prev" type="button" aria-label="Previous photo">‹</button>
<button class="lb-next" type="button" aria-label="Next photo">›</button>
<figure><img alt=""><figcaption aria-live="polite"><strong id="lightbox-title"></strong><span class="lb-desc"></span>
<span class="lb-meta"><span class="lb-count"></span><span class="lb-full"></span></span></figcaption></figure>`;
document.body.append(dialog);
const $ = (s) => dialog.querySelector(s);
const big = $("img");

let group = [];
let index = 0;

function show(i) {
  index = (i + group.length) % group.length;
  const a = group[index];
  big.src = a.href;
  big.alt = a.dataset.alt;
  $("#lightbox-title").textContent = a.dataset.title;
  $(".lb-desc").textContent = a.dataset.desc ?? "";
  $(".lb-count").textContent = group.length > 1 ? `${index + 1} of ${group.length}` : "";
  // Built only when there is a file, so the page never contains an <a> without an href.
  $(".lb-full").replaceChildren(
    ...(a.dataset.full
      ? [
          Object.assign(document.createElement("a"), {
            href: a.dataset.full,
            target: "_blank",
            rel: "noopener",
            textContent: `Full size (JPG, ${a.dataset.fullSize}, opens in new tab)`,
          }),
        ]
      : []),
  );
  // Warm the cache for the next photo so stepping through feels instant.
  if (group.length > 1) new Image().src = group[(index + 1) % group.length].href;
}

document.addEventListener("click", (e) => {
  const a = /** @type {HTMLAnchorElement | null} */ (/** @type {Element} */ (e.target).closest("a.zoom"));
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  group = [...(a.closest(".gallery") ?? document).querySelectorAll("a.zoom")];
  $(".lb-prev").hidden = $(".lb-next").hidden = group.length < 2;
  show(group.indexOf(a));
  dialog.showModal();
});
$(".lb-prev").addEventListener("click", () => show(index - 1));
$(".lb-next").addEventListener("click", () => show(index + 1));
dialog.addEventListener("keydown", (e) => {
  if (group.length < 2) return;
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    show(index - 1);
  }
  if (e.key === "ArrowRight") {
    e.preventDefault();
    show(index + 1);
  }
});
dialog.addEventListener("click", (e) => {
  if (e.target === dialog || e.target === $("figure")) dialog.close();
});
dialog.addEventListener("close", () => {
  big.removeAttribute("src");
  // Return focus to the photo the visitor ended on, not the one they opened.
  group[index]?.focus();
});
