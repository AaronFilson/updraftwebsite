# Updraft Pottery Studio website

Static site (plain HTML/CSS/JS) plus a small AWS Lambda that talks to Square.

```
site/      source: HTML templates, CSS, JS (+ js/test/ unit tests), data/*.json, images/ (full-size masters, never uploaded)
scripts/   build.mjs produces dist/; publish, deploy-api, put-token, serve (local preview)
dist/      generated; this is what gets uploaded to S3
backend/   Lambda: catalog, tax quote, checkout, signup (Square Catalog, Orders, Payments, Customers APIs) + test/
e2e/       browser tests (Playwright) against dist/ with the API mocked
deploy/    CloudFormation for hosting, stage settings, IAM policies; see deploy/README.md
```

## Build

```
npm ci
SITE_URL=https://yourdomain.com npm run build
npm run preview
```

The build:
- makes 400 / 800px AVIF and 400 / 800 / 1600px WebP copies of each photo (cached in `.cache/`). The grid uses 400 or 800 depending on screen (AVIF where the browser supports it); 1600 loads only when a photo is opened.
- puts a content hash in every image file name, so a replaced photo gets a new URL automatically.
- renders the galleries into the pages from `site/data/*.json`, so pages need no data requests.
- adds canonical, Open Graph and icon tags to every page, plus `robots.txt`, `site.webmanifest` and (with `SITE_URL` set) `sitemap.xml`.
- bundles, minifies and content-hashes the JS and CSS, and strips all comments from HTML/CSS/JS.
- the Square payment SDK loads only once something is in the cart.

## Adding your work

1. Put the photo (JPG, metadata stripped) in `site/images/work/` with the next number, e.g. `11.jpg`.
2. Add an entry to `site/data/work.json`:
   ```json
   { "image": "images/work/11.jpg", "title": "Ash-glaze mug", "description": "Wheel thrown stoneware.", "alt": "Speckled grey mug on a wooden table" }
   ```
3. `npm run build` and deploy.

## Selling

Products come straight from your Square catalog. Add items in Square Dashboard > Items & services, with a price and a photo. They appear on the shop within a minute. Shop prices and tax are always calculated by Square on the server.

## Email signup

The "First look at new work" form posts to `/api/subscribe`, which adds the address to your Square customer directory (existing customers are matched by email, not duplicated). To keep website signups separate, create a customer group in Square Dashboard > Customers > Groups (e.g. "Website newsletter"), and pass its id as `NewsletterGroupId` when deploying the API. Send emails to that group with Square Marketing. Check Square's email-marketing consent rules before your first campaign.

Abuse limits: the API is capped at 5 concurrent runs (`ApiConcurrency`), and each running instance allows 5 signup attempts per IP per 10 minutes and ignores repeat signups of the same address within an hour. New AWS accounts with a low Lambda concurrency quota can't reserve concurrency; deploy with `ApiConcurrency=0` there.

## Setup

1. **Square app**: [developer.squareup.com](https://developer.squareup.com/apps) > create an application. Note the Application ID, the Access Token (sandbox first) and your Location ID.
2. **Deploy the API**: put the stage's public Square settings (`squareAppId`, `squareLocationId`, `squareEnv`, `shippingCents`) in `deploy/stages.json`. Put the access token in `backend/.env` (git-ignored) and run `npm run put-token`, which stores it in SSM Parameter Store. Then `npm run deploy:api` and `npm run publish`. Add `-- --stage staging` to any of these for the staging site. Details are in [`deploy/README.md`](deploy/README.md).
3. **Site hosting**: S3 bucket (private) + CloudFront with Origin Access Control, default root object `index.html`, custom error response 404 -> `/error.html`, and an ACM certificate for your domain. Turn on **Compress objects automatically** (gzip/Brotli) in the CloudFront cache behavior. Upload the content-hashed folders with long caching and everything else (HTML, favicon, manifest, robots, sitemap) with short caching:
   ```
   aws s3 sync dist/ s3://YOUR-BUCKET --delete --exclude "*" --include "assets/*" --include "img/*" --include "full/*" --cache-control "public,max-age=31536000,immutable"
   aws s3 sync dist/ s3://YOUR-BUCKET --delete --exclude "assets/*" --exclude "img/*" --exclude "full/*" --cache-control "public,max-age=300"
   ```
   **Security headers**: attach a CloudFront *response headers policy* to the default behavior with HSTS (`max-age=63072000; includeSubDomains`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, frame options `DENY`, and a Content-Security-Policy along these lines (add your API origin to `connect-src` if `apiBase` is not same-origin):
   ```
   default-src 'self'; img-src 'self' data: https://*.squarecdn.com https://items-images-production.s3.us-west-2.amazonaws.com https://items-images-sandbox.s3.us-west-2.amazonaws.com;
   script-src 'self' https://*.squarecdn.com https://js.squareup.com https://js.squareupsandbox.com;
   style-src 'self' 'unsafe-inline' https://*.squarecdn.com; font-src 'self' https://*.squarecdn.com https://d1g145x70srn7h.cloudfront.net;
   connect-src 'self' https://*.squareup.com https://*.squareupsandbox.com https://*.squarecdn.com https://o160250.ingest.sentry.io;
   frame-src https://*.squarecdn.com https://*.squareup.com https://*.squareupsandbox.com https://*.cardinalcommerce.com;
   base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'
   ```
   Check the hosts against Square's current Web Payments SDK CSP docs, and roll it out as `Content-Security-Policy-Report-Only` first, then switch once a sandbox checkout works with no violations.
4. **Go live**: in `deploy/stages.json`, set prod's `squareEnv` to `"production"` with the production application and location IDs. Run `npm run put-token` with the production token, then `npm run deploy:api` and `npm run publish`. Test the whole flow on staging first, with Square's test card `4111 1111 1111 1111`.

## Local preview and checks

```
npm run build && npm run preview   # http://localhost:4173
npm run preview -- --api https://staging.updraftpotterystudio.com   # same, with the shop's data from staging (sandbox)
npm run lint                       # ESLint
npm run typecheck                  # TypeScript over the JS (JSDoc types)
npm run format:check               # Prettier (npm run format to fix)
npm test                           # unit tests: site/js/test and backend/test
npm run test:e2e                   # browser tests in Chromium, Firefox and WebKit (after a build)
```

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs all of these, plus `cfn-lint` on the CloudFormation templates, on every push to master and on pull requests. Deploys run from Actions → Deploy ([`deploy.yml`](.github/workflows/deploy.yml)).
