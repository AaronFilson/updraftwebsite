// IndexNow (Bing, DuckDuckGo, Ecosia, Yahoo, Yandex): tells participating search engines whenever
// production pages are published, instead of waiting days for a re-crawl.
// build.mjs writes dist/<INDEXNOW_KEY>.txt so engines can verify ownership of the host.

export const INDEXNOW_KEY = "b8f4c2e9a1d740639e5c82b1f7a3d904";

/**
 * Submits changed canonical URLs to IndexNow. Never throws: search notification must never fail a deploy.
 * @param {string} siteUrl e.g. https://updraftpotterystudio.com
 * @param {string[]} urls full https:// URLs on the same host
 * @param {typeof fetch} [fetchFn]
 */
export async function submitIndexNow(siteUrl, urls, fetchFn = fetch) {
  const base = siteUrl.replace(/\/$/, "");
  const host = new URL(base).host;
  const urlList = [...new Set(urls)].filter((u) => {
    try {
      return new URL(u).host === host;
    } catch {
      return false;
    }
  });
  if (!urlList.length) return { sent: 0, status: 0 };
  try {
    const res = await fetchFn("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        host,
        key: INDEXNOW_KEY,
        keyLocation: `${base}/${INDEXNOW_KEY}.txt`,
        urlList,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    return { sent: urlList.length, status: res.status };
  } catch (err) {
    return { sent: 0, status: 0, error: err.message };
  }
}
