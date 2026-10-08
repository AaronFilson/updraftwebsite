# Deploying updraftpotterystudio.com

Two stages, each a pair of CloudFormation stacks, configured in [`stages.json`](stages.json) (no secrets there):

| Stage | Site | Stacks |
|---|---|---|
| `prod` | https://updraftpotterystudio.com | `updraft-site`, `updraft-api` |
| `staging` | https://staging.updraftpotterystudio.com (not indexed) | `updraft-staging-site`, `updraft-staging-api` |

Deploys run as the `copper-bell` IAM user locally, or as the `updraft-github-deploy` role from GitHub Actions. Both get the
`updraft-publish` managed policy in [`copper-bell-publish-policy.json`](copper-bell-publish-policy.json), which only
reaches resources named `updraft-*`, parameters under `/updraft/`, and DNS records under `updraftpotterystudio.com`.

| Piece | What |
|---|---|
| site stack ([`site.yaml`](site.yaml)) | Private S3 bucket, CloudFront, HTTPS certificate, security headers; `/api/checkout`, `/api/img` (cached a year) and `/api/*` routed to the functions through origin access control, so the functions only accept requests CloudFront signed; `/p/*` share pages (cached 5 minutes) go to `Api`. Staging's DNS record is in the stack. |
| API stack ([`../backend/template.yaml`](../backend/template.yaml)) | `Api` (catalog, tax quote, signup, `/p/` share pages) and `Checkout` (one order at a time, so a one-of-a-kind piece can't sell twice), from one bundle; `Images` (shop photos resized with sharp, its own package). Square token read from SSM. 30-day log groups, and alarms emailed through SNS. |
| Square token | SSM Parameter Store SecureString `/updraft/<stage>/square-access-token` |
| Production DNS | apex + `www` A/AAAA aliases to CloudFront, switched with `node scripts/dns-cutover.mjs` |

## Everyday

```
npm run publish -- --stage staging    # build, upload, invalidate CloudFront (staging)
npm run publish                       # same for production
npm run deploy:api -- --stage staging # API + CloudFront routing; then publish
```

Or from GitHub: Actions → Deploy → Run workflow → pick the stage (production asks for approval).

## Square token

```
npm run put-token -- --stage staging  # reads SQUARE_ACCESS_TOKEN from backend/.env (git-ignored) or the environment
npm run put-token                     # production
```

The token goes straight into SSM (via a temporary file, never printed). The functions read it on their next cold start;
redeploy to pick up a new one immediately. After replacing a token in Square, run this and redeploy.

## Safety checks in the deploy

- `deploy:api` refuses to deploy (and deletes the upload) if a code package is over 3 MB, which would mean the whole
  `backend/` folder, `.env` included, was zipped instead of the bundle.
- Switching an older stack from public function URLs to CloudFront-only goes site first (CloudFront starts
  signing, which public URLs ignore), then API (URLs locked; CloudFront's permission applies at once), so the
  shop keeps working throughout.

## One-time admin setup (AWS console, signed in as an admin)

1. **Update `updraft-publish`:** IAM → Policies → `updraft-publish` → Edit → JSON → replace with
   [`copper-bell-publish-policy.json`](copper-bell-publish-policy.json) → Save (set as default version).
2. **Create `updraft-lambda-ssm-read`:** IAM → Policies → Create policy → JSON → paste
   [`lambda-ssm-read-policy.json`](lambda-ssm-read-policy.json) → name exactly `updraft-lambda-ssm-read`. The deploy can
   attach only this and the basic Lambda logging policy to the functions it creates.
3. **CI deploy role (optional, for GitHub Actions):** IAM → Roles → Create role → Custom trust policy → paste
   [`github-deploy-trust.json`](github-deploy-trust.json) → attach `updraft-publish` → name `updraft-github-deploy`.
   (GitHub's OIDC provider already exists in the account, from glazecalc.) Then in GitHub: Settings → Environments →
   create `staging` and `production` (add yourself as a required reviewer on production), each with variable
   `AWS_DEPLOY_ROLE_ARN` = the role's ARN.
4. **Alarm emails:** after the first API deploy, confirm the "AWS Notification - Subscription Confirmation" email.

## Switching the domain (one time) and rolling back

```
node scripts/dns-cutover.mjs --dry-run   # show the change
node scripts/dns-cutover.mjs             # apex + www -> CloudFront (UPSERT, no downtime)
node scripts/dns-cutover.mjs --rollback  # back to the old us-west-2 S3 website
```

The old 2017 site lives in the S3 website buckets `updraftpotterystudio.com` / `www.updraftpotterystudio.com`
in us-west-2. `copper-bell` cannot see or change them; an admin can delete them once the new site is settled.
