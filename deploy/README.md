# Deploying updraftpotterystudio.com

Everything runs as the `copper-bell` IAM user (default AWS CLI profile), whose permissions come from the
`updraft-publish` managed policy in [`copper-bell-publish-policy.json`](copper-bell-publish-policy.json).
That policy only reaches resources named `updraft-*` and DNS records under `updraftpotterystudio.com`.

| Piece | What | How it is managed |
|---|---|---|
| `updraft-site` stack ([`site.yaml`](site.yaml)) | S3 bucket `updraft-site-724654236968`, CloudFront, HTTPS certificate, security headers | `aws cloudformation deploy` |
| `updraft-api` stack ([`../backend/template.yaml`](../backend/template.yaml)) | Lambda + Function URL for shop and signup | see the main README |
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

Once the API is deployed, route `/api/*` through CloudFront so the site can keep `apiBase: ""`:

```
aws cloudformation deploy --template-file deploy/site.yaml --stack-name updraft-site \
  --parameter-overrides ApiDomain=<function-url-host-without-https-or-slash>
```

## Switching the domain (one time) and rolling back

```
node scripts/dns-cutover.mjs --dry-run   # show the change
node scripts/dns-cutover.mjs             # apex + www -> CloudFront (UPSERT, no downtime)
node scripts/dns-cutover.mjs --rollback  # back to the old us-west-2 S3 website
```

The old 2017 site lives in the S3 website buckets `updraftpotterystudio.com` / `www.updraftpotterystudio.com`
in us-west-2. `copper-bell` cannot see or change them; an admin can delete them once the new site is settled.
