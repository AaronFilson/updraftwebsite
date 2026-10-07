// Minimal browser stand-ins so the site's modules run under node:test.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
globalThis.document = new EventTarget(); // cart.js announces changes with document.dispatchEvent
globalThis.__SITE_CONFIG__ = { squareEnv: "sandbox", squareAppId: "test-app", squareLocationId: "test-location", shippingCents: 0 };
