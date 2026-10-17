# Search and marketing: feature list

This plan helps people find the studio and its pieces in search, and gives shared links and the newsletter more to work with. It was written on 16 October 2026 against master 6a9f848, after reading the site's build and backend and glazecalc's search plan (`glazecalc/docs/seo-plan.md`, ADR 16). Effort: S = under a day, M = one to three days, L = a week or more. Paths are from the repo root.

## Status: items 1–3 built (16 October 2026, branch `seo-pieces`), not yet deployed

Built as planned, with these differences:

- **The pieces' sitemap is `/p/sitemap.xml`,** not `/sitemap-pieces.xml`. The existing `/p/*` route already reaches the API, so CloudFront needs no new behaviour, and a sitemap under `/p/` may list exactly the pages under `/p/`.
- **The shell is `piece-shell.html`,** kept out by `robots.txt`. On staging it carries the build's `noindex`, so staging's piece pages do too.
- **The piece page has its own Add to cart** (`site/js/piece-page.js`), not only a link into the shop. Without the script it shows "Buy in the shop".
- **The shop's opening words (item 3) are unchanged:** they wait on decision 2.
- Decisions 1 and 5 went as recommended: sold pieces keep their page, and a card's name links to `/p/<id>` while a click still opens the detail view.

## Where the site stands

**What is already right:**

- Every page is static HTML with its own `<title>` and description (`site/*.html`). Glazecalc had to prerender its single-page app to get this; Updraft has it already.
- `scripts/build.mjs` (`headMeta`) writes the canonical address, Open Graph and Twitter tags, and the icons. It also writes `robots.txt` and `sitemap.xml` when `SITE_URL` is set. Staging is `noindex` and disallowed (`deploy/stages.json`, `indexable: false`).
- The home page has LocalBusiness JSON-LD with the Instagram and Facebook pages in `sameAs`.
- Each piece has a share link, `/p/<id>` (`backend/src/piece.mjs`), with its own photo, name and price in the preview tags. Sold or archived pieces answer 410.
- Lighthouse runs in CI and scores 99–100.

**What holds it back:**

1. **The pieces cannot be found in search.**
   - The shop's cards and its Product JSON-LD are drawn by `site/js/shop.js` once `/api/catalog` answers. Google usually renders that. Bing, DuckDuckGo and link previews of `/shop.html` do not.
   - `/p/<id>` is `noindex` and canonical to `/shop.html`. It only redirects to the shop (`site/p.js`).
   - The sitemap lists the 9 static pages and no pieces.
2. **The pages' words may not be the ones people search for.** "Handmade ceramics in Tacoma" is in the home title. The shop's description is one short line.
3. **The structured data is thin, and one part may be wrong.**
   - Google expects a LocalBusiness to have a street address, and the studio publishes none.
   - The shop's ItemList puts full Products on a list page. Google's product results want them on each product's own page.
   - The other pages have no structured data.
4. **No search account is set up.** The site may not be verified in Google Search Console or Bing Webmaster Tools. There is no Google Business Profile and no Merchant Center listing.
5. **Nothing is measured.** The site has no analytics, and links in the newsletter and on social posts carry no campaign tags.

## Must do

1. **Piece pages worth finding.** `/p/<id>` becomes the real page for a piece, with the site's header, footer and styles.
   - **The page shell comes from the build.**
     - New `site/piece.html`, built by the same `page()` pipeline, so it gets the header, footer, inlined CSS and hashed scripts. Its body has placeholders for the piece.
     - The build leaves it out of the sitemap, and it carries `noindex` itself.
     - `piece.mjs` reads `${ALLOWED_ORIGIN}/piece.html` and keeps it in memory for up to 5 minutes. `images.mjs` already re-reads the catalog from the site the same way. Each publish therefore restyles the piece pages with no API deploy.
     - If that read fails, the page falls back to today's plain page, so it never errors.
   - **Body:**
     - `<h1>` with the name, then the photos as `/api/img` `srcset`s (the same widths as the detail view).
     - The price, or "Sold".
     - The spec line, then the full description.
     - "Add to cart", a link to `/shop.html#p-<id>` that opens today's detail view, where the cart already works.
     - A "More in the shop" link.
     - Breadcrumbs: Shop › Mugs › name.
   - **Head:**
     - Title: `<name>: handmade <category> | Updraft Pottery Studio`. Description: the spec line.
     - Canonical to itself. `noindex` and the `/p.js` redirect are removed.
     - `og:type product`, plus `product:price:amount` and `product:price:currency`, which Facebook and Pinterest read.
     - JSON-LD: a Product with an Offer (price, currency, availability, `itemCondition` New, the seller), and a BreadcrumbList.
   - **Sold pieces** (decision 1): recommend they stay up at 200 with "Sold", `SoldOut` availability and links to what is available. They then work as a portfolio, and links people made keep working. Archived or deleted pieces stay 410.
   - **The shop links to them.**
     - Each card's name becomes a real `<a href="/p/<id>">`. A click still opens the detail view in place (the script stops the link's default), but crawlers and new tabs get the page.
     - The detail view's "Share" keeps using `/p/<id>`.
   - Cache: the existing `PieceCachePolicy` (5 minutes) stays.
   - CSP: none needed, since the page uses the site's own scripts and inlined styles. `style-src` already allows inline styles.
   - Effort M. Files: new `site/piece.html`, `scripts/build.mjs`, `backend/src/piece.mjs`, `site/p.js` (removed once nothing loads it), `site/js/shop.js`, `site/js/piece-view.js`, `site/css/style.css`.

2. **A sitemap with the pieces.**
   - `sitemap.xml` becomes a sitemap index. It lists `/sitemap-pages.xml`, written by the build as today, and `/sitemap-pieces.xml`, answered by the API from the catalog.
   - The pieces' sitemap lists every unarchived piece, sold ones too if decision 1 keeps them. `lastmod` is Square's `updatedAt`.
   - A new CloudFront behaviour sends `/sitemap-pieces.xml` to the API with the pieces' cache policy.
   - `robots.txt` is unchanged; it already names `sitemap.xml`.
   - Effort S. Files: `scripts/build.mjs`, `backend/src/handler.mjs`, new `backend/src/sitemap.mjs`, `deploy/site.yaml` (one behaviour), `scripts/publish.mjs` (the invalidation list).

3. **The shop page's own content.**
   - Once each piece has its own Product data, the shop's JSON-LD becomes an ItemList of the pieces' addresses only (`productData` in `site/js/shop-logic.js`).
   - The shop gets a description and a short opening paragraph a search engine can read without the script, with the place and what is made (decision 2 sets the words).
   - Effort S. Files: `site/shop.html`, `site/js/shop-logic.js`, its unit test.

4. **Words people search for.**
   - Check the usual search terms for each page. Candidates to verify:
     - "Tacoma pottery", "handmade pottery Tacoma", "Tacoma ceramics"
     - "handmade mugs", "porcelain bowl", "celadon", "soda fired pottery", "wood/soda kiln"
     - "pottery Pacific Northwest"
   - Sources: Google's autocomplete from a Tacoma location, Google Trends, the words the surveyed potters' sites use (see the 250-site survey), and, after a month, Search Console's own query report (item 6).
   - Rewrite the title, description and `<h1>` of each page where the usual term is missing. Keep each title under about 60 characters.
   - Square item names are the piece pages' titles. Add a short naming guide to the listing checklist, for example "Celadon porcelain mug, 12 oz" rather than only "Morning mug".
   - Effort M (research), then S to change the text. The owner approves all wording. Files: `site/*.html`, the listing checklist.

5. **Structured data on every page.**
   - **Home** (decision 3): recommend OnlineStore, a kind of Organization, in place of LocalBusiness.
     - It keeps the name, logo, `sameAs` and Tacoma as `areaServed`, with no street address.
     - It adds `hasMerchantReturnPolicy`, from the returns policy in `policies.html`.
     - Google's merchant listings read the return policy, so it helps the piece pages too.
     - If a Google Business Profile is made (item 6), LocalBusiness can come back with the profile's service area.
   - **About:** ProfilePage, whose `mainEntity` is a Person (Aaron Filson) with `sameAs` and `worksFor`.
   - **Kilns:** an Article for each project, with its dates.
   - **Terms:** a DefinedTermSet with one DefinedTerm for each word.
   - **Piece pages:** from item 1. Add `shippingDetails` once shipping prices are set (pending; see the shipping memory).
   - Data that never changes is written in the page's source, as the home page's is. Values the build knows (site address, image) use the existing `{{root}}`/`{{og}}` placeholders.
   - Check each type with Google's Rich Results Test and the Schema.org validator before merge.
   - Effort S. Files: `site/index.html`, `site/about.html`, `site/kilns.html`, `site/terms.html`, `backend/src/piece.mjs`.

6. **Owner's tasks (outside the code).**
   - **Google Search Console:** add a Domain property with a DNS TXT record in the Route 53 zone (Z88UBBDI22ZJ9), then submit `https://updraftpotterystudio.com/sitemap.xml`.
   - **Bing Webmaster Tools:** import the site from Search Console. Bing's index also feeds DuckDuckGo, Ecosia and Yahoo.
   - **Google Business Profile:** a service-area business in Tacoma with the address hidden, under the closest pottery category. Link it to the site. Post photos from each kiln opening. This is what shows on Maps and in "pottery near me" searches.
   - **Google Merchant Center** (free listings): add the site and let it read the piece pages' Product data, after item 1 is live. Set shipping and returns there as well. Pieces can then show in the Shopping tab at no cost.
   - **Links from other sites** matter most over time, and they come from people:
     - Tacoma and Pierce County arts listings
     - local potters' guilds and the studios where Aaron learned
     - clay suppliers' "made with" pages
     - the soda-kiln builders
     - Instagram and Facebook profiles linking to the site
   - After a month: read Search Console's Pages and Queries reports, and feed the queries back into item 4.
   - Effort: an hour or two to set up, then ongoing. None of it needs the code; it can start today.

7. **Tests.**
   - **Unit (`node --test`, backend):**
     - `piece.mjs` fills the shell with the name, price, photos and JSON-LD, and escapes all of them.
     - A sold piece shows "Sold" and `SoldOut`.
     - An unknown id answers 410.
     - A failed shell read falls back to the plain page.
     - The pieces' sitemap lists the catalog's pieces with `lastmod`.
   - **Build:**
     - `sitemap.xml` is an index naming both sitemaps.
     - `piece.html` is not in `sitemap-pages.xml` and carries `noindex`.
     - Each page has exactly one `<h1>`, a title of at most 60 characters, and a description of 70–160 characters.
   - **e2e (Playwright), extending `e2e/piece.spec.mjs` and `e2e/pages.spec.mjs`:**
     - With JavaScript off, `/p/<id>` shows its name, price, photo and description, and has its own canonical address and no `noindex`.
     - With JavaScript off, every static page shows its heading and text.
     - A card's name is a real link to `/p/<id>`, and clicking it still opens the detail view.
     - Each page's JSON-LD parses and has the expected `@type`.
     - axe passes on a piece page.
   - **Lighthouse:** add `/p/<id>` (from the e2e fixture) to `lighthouserc.json`.
   - Effort M.

## Marketing

These use what the site already has. Most are the owner's.

8. **Newsletter drops.**
   - The signup already fills the "Website newsletter" group in Square's customer directory (`backend/src/subscribe.mjs`).
   - Send an email from Square Marketing to that group when new work is listed, with links to the piece pages from item 1.
   - Effort: the owner's, per drop.
9. **Campaign tags on outgoing links.**
   - `?utm_source=newsletter&utm_medium=email&utm_campaign=<drop>`, and the same for Instagram and Facebook.
   - They do nothing until something reads them (item 10), but adding them now costs nothing.
   - The detail view's "Share" could add `utm_source=share`.
   - Effort S.
10. **Measurement** (decision 4).
    - Recommend no analytics script for now. The site has none, which keeps it fast and free of a cookie banner.
    - Search Console (item 6) covers search, and Square's reports cover sales.
    - If more is wanted later, CloudFront's standard logs to S3 with an Athena query cost cents and add nothing to the page.
11. **Pinterest.**
    - Pottery does well there. Verify the domain, and Rich Pins will read the piece pages' Open Graph and Product data (item 1).
    - Effort: the owner's, under an hour.

## Later

12. **IndexNow** (Bing, Yandex, Seznam, Naver): tell them about changed pages after each publish (`scripts/publish.mjs`). A Square webhook could do the same for pieces when one sells or is listed. Effort S (publish), M (webhook).
13. **Kiln-opening posts.** A short page for each firing, with photos and the pieces that came out of it, linked from the newsletter. These are pages people link to and that bring repeat searches. Kiln-opening dates were deferred earlier. Effort S each, mostly writing.
14. **Category pages** (`/shop/mugs`), prerendered at publish from the catalog, if the shop grows past what one page holds well. Effort M.
15. **Clearing a sold piece's cache at once.** A Square webhook invalidates `/p/<id>` rather than waiting the 5 minutes. Effort S, with item 12's webhook.

## Decisions for the owner

1. **Sold pieces: keep the page or 410?** Recommend **keep it** (200, "Sold", links to available work). It works as a portfolio and keeps shared links alive. Archiving a piece in Square still removes it.
2. **The shop's opening words.** Recommend one or two plain sentences with the place and the work, for example "Porcelain and stoneware for everyday use, made and fired in Tacoma, Washington." Final wording is yours, after item 4's research.
3. **Home page type: OnlineStore or LocalBusiness?** Recommend **OnlineStore** until there is a Google Business Profile. Then LocalBusiness can come back with its service area.
4. **Analytics?** Recommend **none for now** (item 10).
5. **Card links.** Recommend the card's name links to `/p/<id>` and a click still opens the detail view. The alternative is to send every click to the piece page, which is simpler but leaves the shop for each piece.

## Build order

**Step 0 (owner, today):** item 6's accounts. They need no code, and Search Console's data takes weeks to build up.

**Then one branch, `seo-pieces`:** items 1, 2 and 3 together. The sitemap and the shop's JSON-LD depend on the piece pages. Deploy order:

1. the API (`npm run deploy:api`), which brings the new piece page and the pieces' sitemap;
2. the site stack, for the CloudFront behaviour;
3. publish.

The piece page falls back to the plain page until `piece.html` is published, so the order is safe.

**Then `seo-words`:** items 4 and 5, after the search-term research and the owner's wording. Item 7's tests go with each branch.

**Then Merchant Center** (item 6) once piece pages are live on production Square, not the sandbox.

Before each merge: `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:e2e`, Lighthouse, and the Rich Results Test on a piece page and the home page.
