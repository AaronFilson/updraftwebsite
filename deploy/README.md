# Deploying updraftpotterystudio.com

Everything runs as the `copper-bell` IAM user (default AWS CLI profile), whose permissions come from the
`updraft-publish` managed policy in [`copper-bell-publish-policy.json`](copper-bell-publish-policy.json).
That policy only reaches resources named `updraft-*` and DNS records under `updraftpotterystudio.com`.

| Piece | What | How it is managed |
|---|---|---|
| `updraft-site` stack ([`site.yaml`](site.yaml)) | S3 bucket `updraft-site-724654236968`, CloudFront, HTTPS certificate, security headers | `aws cloudformation deploy` |
| `updraft-api` stack ([`../backend/template.yaml`](../backend/template.yaml)) | Two Lambdas from one bundle: `Api` (catalog, tax quote, signup) and `Checkout` (one order at a time, so a one-of-a-kind piece can't sell twice) | `npm run deploy:api` |
| DNS (zone `Z88UBBDI22ZJ9`) | apex + `www` A/AAAA aliases to CloudFront | `node scripts/dns-cutover.mjs` |

## Publish an update (the usual task)

```
npm run publish               # build, upload, invalidate CloudFront
npm run publish -- --dry-run  # preview what would change
```

## Change the infrastructure

```
aws cloudformation deploy --template-file deploy/site.yaml --stack-name updraft-site
```

Parameters you don't pass (like `ApiDomain`) keep their current values.

## Deploy or update the Square API

```
cp backend/.env.example backend/.env   # once; fill in SQUARE_ACCESS_TOKEN etc. (git-ignored)
npm run deploy:api
```

This bundles `backend/src/handler.mjs` with esbuild (only the bundle is uploaded, so `.env` never ships),
deploys the `updraft-api` stack via the `updraft-artifacts-724654236968` bucket, and redeploys `updraft-site`
with `ApiDomain`/`CheckoutDomain` so CloudFront routes `/api/checkout` to the checkout function and the rest of `/api/*` to the API.
The script refuses to deploy (and deletes the upload) if a code package is over 3 MB, which would mean the whole
`backend/` folder, `.env` included, was zipped instead of the bundle. The token goes from `.env` straight to AWS and is never printed.

## Switching the domain (one time) and rolling back

```
node scripts/dns-cutover.mjs --dry-run   # show the change
node scripts/dns-cutover.mjs             # apex + www -> CloudFront (UPSERT, no downtime)
node scripts/dns-cutover.mjs --rollback  # back to the old us-west-2 S3 website
```

The old 2017 site lives in the S3 website buckets `updraftpotterystudio.com` / `www.updraftpotterystudio.com`
in us-west-2. `copper-bell` cannot see or change them; an admin can delete them once the new site is settled.
