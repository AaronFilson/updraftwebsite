// Detail view for one piece: all of its photos (buttons, arrow keys or a swipe), the spec line and
// full description, Add to cart, and a link to share. shop.js opens it for #p-ITEM links, so it works
// from the home page, from a shared /p/ITEM link (which forwards here) and with the back button.
import { picture } from "./photos.js";
import { specLine, descriptionRest } from "./shop-logic.js";

/**
 * @param {{ buyControls: (item: any) => { sel: HTMLElement, row: HTMLElement, dispose: () => void }, onClose: (item: any) => void }} deps
 */
export function createPieceView({ buyControls, onClose }) {
  const dialog = document.createElement("dialog");
  dialog.className = "piece";
  dialog.setAttribute("aria-labelledby", "piece-title");
  dialog.innerHTML = `<div class="piece-photos">
  <div class="piece-frame"></div>
  <button class="piece-prev" type="button" aria-label="Previous photo">‹</button>
  <button class="piece-next" type="button" aria-label="Next photo">›</button>
  <p class="piece-count" aria-live="polite"></p>
</div>
<div class="piece-info">
  <form method="dialog"><button class="piece-close" aria-label="Close">×</button></form>
  <h2 id="piece-title"></h2>
  <p class="piece-spec"></p>
  <div class="piece-desc"></div>
  <div class="piece-buy"></div>
  <p class="piece-more"><button type="button" class="link-btn piece-share">Share this piece</button><a href="/care.html">Care &amp; use</a></p>
  <p class="piece-shared" role="status"></p>
</div>`;
  document.body.append(dialog);
  const $ = (s) => /** @type {HTMLElement} */ (dialog.querySelector(s));

  let item = null;
  let photos = [];
  let index = 0;
  let controls = null;

  function show(i) {
    index = (i + photos.length) % photos.length;
    $(".piece-frame").replaceChildren(
      photos.length
        ? picture(photos[index], {
            sizes: "(min-width: 900px) 560px, 100vw",
            widths: [800, 1600],
            alt: `${item.name}, photo ${index + 1}`,
            eager: true,
          })
        : Object.assign(document.createElement("div"), { className: "ph" }),
    );
    $(".piece-count").textContent = photos.length > 1 ? `${index + 1} of ${photos.length}` : "";
  }

  function open(next) {
    item = next;
    photos = item.images?.length ? item.images : item.image ? [item.image] : [];
    $(".piece-prev").hidden = $(".piece-next").hidden = photos.length < 2;
    $("#piece-title").textContent = item.name;
    $(".piece-spec").textContent = specLine(item.description);
    $(".piece-desc").replaceChildren(
      ...descriptionRest(item.description).map((t) => Object.assign(document.createElement("p"), { textContent: t })),
    );
    controls?.dispose();
    controls = buyControls(item);
    $(".piece-buy").replaceChildren(controls.sel, controls.row);
    $(".piece-shared").textContent = "";
    show(0);
    if (!dialog.open) dialog.showModal();
  }

  $(".piece-prev").addEventListener("click", () => show(index - 1));
  $(".piece-next").addEventListener("click", () => show(index + 1));
  dialog.addEventListener("keydown", (e) => {
    if (photos.length < 2 || /** @type {Element} */ (e.target).closest("select")) return;
    if (e.key === "ArrowLeft") show(index - 1);
    if (e.key === "ArrowRight") show(index + 1);
  });
  // Swipe between photos on touch screens (vertical scrolling still works: touch-action in the CSS).
  let startX = null;
  $(".piece-frame").addEventListener("pointerdown", (e) => (startX = e.clientX));
  $(".piece-frame").addEventListener("pointerup", (e) => {
    if (startX === null || photos.length < 2) return;
    const dx = e.clientX - startX;
    startX = null;
    if (Math.abs(dx) > 40) show(index + (dx < 0 ? 1 : -1));
  });
  // A click on the backdrop (outside the panel) closes, like the photo lightbox.
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });

  // Phones get the system share sheet; elsewhere the link is copied (and shown, in case copying is blocked).
  $(".piece-share").addEventListener("click", async () => {
    const url = `${location.origin}/p/${encodeURIComponent(item.id)}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: item.name, url });
        return;
      } catch (err) {
        if (err.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      $(".piece-shared").textContent = `Link copied: ${url}`;
    } catch {
      $(".piece-shared").textContent = `Link to share: ${url}`;
    }
  });

  dialog.addEventListener("close", () => {
    controls?.dispose();
    controls = null;
    onClose(item);
  });

  return { open, close: () => dialog.close(), isOpen: () => dialog.open };
}
