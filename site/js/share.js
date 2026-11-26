// Shares a piece's /p/<id> page: native share sheet on phones, clipboard copy (or visible URL) elsewhere.
/**
 * @param {{ id: string, name: string }} item
 * @param {HTMLElement} statusEl
 */
export async function sharePiece(item, statusEl) {
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
    statusEl.textContent = `Link copied: ${url}`;
  } catch {
    statusEl.textContent = `Link to share: ${url}`;
  }
}
