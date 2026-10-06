// Deploys the Square API (backend/template.yaml) as the updraft-api stack, then routes /api/* to it
// through the updraft-site CloudFront distribution, so the site can keep apiBase: "".
//   npm run deploy:api
// Settings come from backend/.env (copy backend/.env.example). The access token is read from that
// file and passed straight to AWS; it is never printed. Uses the default AWS profile (copper-bell).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";

const ROOT = path.resolve(import.meta.dirname, "..");
const BACKEND = path.join(ROOT, "backend");
const API_STACK = "updraft-api";
const SITE_STACK = "updraft-site";
const SITE_ORIGIN = "https://updraftpotterystudio.com";

const aws = (...args) => execFileSync("aws", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const step = (msg) => console.log(`\n== ${msg}`);

// --- settings from backend/.env -------------------------------------------------------------
const envFile = path.join(BACKEND, ".env");
if (!existsSync(envFile)) throw new Error("backend/.env not found. Copy backend/.env.example to backend/.env and fill it in.");
const env = Object.fromEntries(
  readFileSync(envFile, "utf8").split(/\r?\n/)
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/))
    .filter(Boolean)
    .map(([, k, v]) => [k, v.replace(/^(['"])(.*)\1$/, "$2")]),
);
const need = (k) => { if (!env[k]) throw new Error(`${k} is empty in backend/.env`); return env[k]; };
const token = need("SQUARE_ACCESS_TOKEN");
const squareEnv = env.SQUARE_ENV || "sandbox";
if (!["sandbox", "production"].includes(squareEnv)) throw new Error("SQUARE_ENV must be sandbox or production");
if (squareEnv === "sandbox" && !token.startsWith("EAAA")) console.warn("Note: sandbox access tokens usually start with EAAA.");

const account = JSON.parse(aws("sts", "get-caller-identity", "--output", "json")).Account;
const artifacts = `updraft-artifacts-${account}`;

// --- package and deploy the Lambda ----------------------------------------------------------
step(`Artifact bucket ${artifacts}`);
try {
  aws("s3api", "head-bucket", "--bucket", artifacts);
  console.log("exists");
} catch {
  aws("s3", "mb", `s3://${artifacts}`);
  aws("s3api", "put-public-access-block", "--bucket", artifacts, "--public-access-block-configuration",
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true");
  console.log("created (private)");
}

// Bundle handler + Square SDK into one file; template.yaml's CodeUri points at this folder only.
step("Bundling");
const BUILD = path.join(BACKEND, ".build");
rmSync(BUILD, { recursive: true, force: true });
await esbuild.build({
  entryPoints: [path.join(BACKEND, "src", "handler.mjs")],
  outfile: path.join(BUILD, "index.mjs"),
  bundle: true, platform: "node", target: "node22", format: "esm", minify: true, legalComments: "none",
  // The Square SDK uses require() internally; give the ES module bundle a real one.
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  logLevel: "info",
});

step("Packaging");
const packaged = path.join(BACKEND, "packaged.yaml");
aws("cloudformation", "package", "--template-file", path.join(BACKEND, "template.yaml"),
  "--s3-bucket", artifacts, "--s3-prefix", API_STACK, "--output-template-file", packaged);

// Guard: every uploaded code package must be the small bundle. A big one means the template made
// `package` zip the whole backend folder (with .env); delete it and stop before anything deploys.
step("Checking packaged code");
const uris = [...new Set([...readFileSync(packaged, "utf8").matchAll(/CodeUri:\s*(s3:\/\/\S+)/g)].map((m) => m[1]))];
if (!uris.length) throw new Error("No packaged CodeUri found; refusing to deploy.");
for (const uri of uris) {
  const [, bucketName, key] = uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  const size = Number(aws("s3api", "head-object", "--bucket", bucketName, "--key", key, "--query", "ContentLength", "--output", "text"));
  if (size > 3 * 1024 * 1024) {
    aws("s3", "rm", uri);
    rmSync(packaged, { force: true });
    throw new Error(`Packaged code ${uri} is ${(size / 1048576).toFixed(1)} MB, so it is not just the bundle (it may contain backend/.env). Deleted it; fix CodeUri in backend/template.yaml.`);
  }
  console.log(`${uri}: ${(size / 1024).toFixed(0)} KB ok`);
}

step(`Deploying ${API_STACK} (${squareEnv})`);
const params = {
  SquareAccessToken: token,
  SquareLocationId: need("SQUARE_LOCATION_ID"),
  SquareEnv: squareEnv,
  ShippingCents: env.SHIPPING_CENTS || "0",
  SiteOrigin: SITE_ORIGIN,
  NewsletterGroupId: env.NEWSLETTER_GROUP_ID || "",
  ApiConcurrency: env.API_CONCURRENCY || "5",
};
try {
  aws("cloudformation", "deploy", "--template-file", packaged, "--stack-name", API_STACK,
    "--capabilities", "CAPABILITY_IAM", "CAPABILITY_AUTO_EXPAND", "--no-fail-on-empty-changeset",
    "--parameter-overrides", ...Object.entries(params).map(([k, v]) => `${k}=${v}`));
} finally {
  rmSync(packaged, { force: true });
}

const apiOutputs = Object.fromEntries(JSON.parse(aws("cloudformation", "describe-stacks", "--stack-name", API_STACK,
  "--query", "Stacks[0].Outputs", "--output", "json")).map((o) => [o.OutputKey, o.OutputValue]));
const apiHost = new URL(apiOutputs.ApiUrl).host;
const checkoutHost = new URL(apiOutputs.CheckoutUrl).host;
console.log(`API: ${apiOutputs.ApiUrl}\nCheckout: ${apiOutputs.CheckoutUrl}`);

// --- route /api/* through CloudFront --------------------------------------------------------
step(`Routing /api/* on ${SITE_STACK} to ${apiHost}, /api/checkout to ${checkoutHost}`);
aws("cloudformation", "deploy", "--template-file", path.join(ROOT, "deploy", "site.yaml"), "--stack-name", SITE_STACK,
  "--no-fail-on-empty-changeset", "--parameter-overrides", `ApiDomain=${apiHost}`, `CheckoutDomain=${checkoutHost}`);
const site = JSON.parse(aws("cloudformation", "describe-stacks", "--stack-name", SITE_STACK,
  "--query", "Stacks[0].Outputs[?OutputKey=='DistributionDomain'].OutputValue", "--output", "json"))[0];

console.log(`\nDone. Check https://${site}/api/catalog (CloudFront can take a few minutes to pick up the new route).`);
console.log("Make sure site/js/config.js has squareEnv, squareAppId and squareLocationId for this environment, then npm run publish.");
