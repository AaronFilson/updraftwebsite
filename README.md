# Updraft Pottery Studio website

Static site (plain HTML/CSS/JS) plus a small AWS Lambda that talks to Square.

```
site/      source: HTML templates, CSS, JS, data/*.json, images/ (full-size masters, never uploaded)
scripts/   build.mjs: produces dist/
dist/      generated; this is what gets uploaded to S3
backend/   Lambda: GET /api/catalog, POST /api/checkout (Square Catalog, Orders, Payments APIs)
```

## Build

```
npm ci
SITE_URL=https://yourdomain.com npm run build
npm run preview
```

The build:
- makes 400 / 800 / 1600px WebP copies of each photo (cached in `.cache/`). The grid uses 400 or 800 depending on screen; 1600 loads only when a photo is opened.
- renders the galleries into `index.html` from `site/data/*.json`, so the home page needs no data requests.
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

## Setup

1. **Square app**: [developer.squareup.com](https://developer.squareup.com/apps) > create an application. Note the Application ID, the Access Token (sandbox first) and your Location ID.
2. **Deploy the API** (AWS CLI only; SAM CLI not required):
   ```
   cd backend && npm ci --omit=dev
   aws cloudformation package --template-file template.yaml --s3-bucket YOUR-ARTIFACT-BUCKET --output-template-file packaged.yaml
   aws cloudformation deploy --template-file packaged.yaml --stack-name updraft-api --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND \
     --parameter-overrides SquareAccessToken=... SquareLocationId=... SquareEnv=sandbox ShippingCents=0 SiteOrigin=https://yourdomain.com
   ```
   Copy the `ApiUrl` output (without the trailing `/`) into `site/js/config.js` as `apiBase`, along with `squareAppId`, `squareLocationId`, `squareEnv`, `shippingCents`.
3. **Site hosting**: S3 bucket (private) + CloudFront with Origin Access Control, default root object `index.html`, custom error response 404 -> `/error.html`, and an ACM certificate for your domain. Turn on **Compress objects automatically** (gzip/Brotli) in the CloudFront cache behavior. Upload with long caching for hashed/immutable files and revalidation for HTML:
   ```
   aws s3 sync dist/ s3://YOUR-BUCKET --delete --exclude "*.html" --cache-control "public,max-age=31536000,immutable"
   aws s3 sync dist/ s3://YOUR-BUCKET --exclude "*" --include "*.html" --cache-control "public,max-age=300"
   ```
   Images are named by number, so if you ever *replace* a photo with the same number, invalidate `/img/*` in CloudFront.
4. **Go live**: redeploy the API with `SquareEnv=production` and the production token, and set `squareEnv: "production"` and the production application ID in `config.js`. Test the whole flow in sandbox first with Square's test card `4111 1111 1111 1111`.

## Local preview

```
npm run build && npm run preview
cd backend && npm test
```
