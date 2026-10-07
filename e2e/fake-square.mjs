// Replaces Square's payment SDK with a tiny fake, so checkout can be driven end to end offline.
// card.tokenize records what the site passed (billing contact etc.) on window.__tokenized.
const FAKE_SDK = `
window.Square = {
  payments() {
    return {
      async card() {
        return {
          async attach(selector) { document.querySelector(selector).innerHTML = '<p data-fake-card>Card form (test)</p>'; },
          configure() {},
          async tokenize(details) { window.__tokenized = details; return { status: "OK", token: "test-token" }; },
        };
      },
    };
  },
};`;

export const fakeSquare = (page) =>
  page.route("**/v1/square.js", (route) => route.fulfill({ contentType: "text/javascript", body: FAKE_SDK }));
