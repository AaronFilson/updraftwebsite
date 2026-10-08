// Deploys the Square API (backend/template.yaml) and the site stack that fronts it, for one stage.
//   npm run deploy:api                     production (stacks updraft-api, updraft-site)
//   npm run deploy:api -- --stage staging  staging (updraft-staging-api, updraft-staging-site)
// Settings come from deploy/stages.json. The Square token is read by the functions from SSM
// Parameter Store (npm run put-token); it never passes through this script or CloudFormation.
// The function URLs only accept requests signed by CloudFront (AuthType AWS_IAM + origin access
// control). An older stack with public URLs is switched site-first, so the shop keeps working
// throughout (see below). Uses the default AWS profile (copper-bell) or the CI role.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";
import { currentStage } from "./stage.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const BACKEND = path.join(ROOT, "backend");
const stage = currentStage();

const aws = (...args) => execFileSync("aws", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const tryAws = (...args) => {
  try {
    return execFileSync("aws", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return null;
  }
};
const step = (msg) => console.log(`\n== ${msg}`);
const stackParam = (stack, key) => {
  const out = tryAws(
    "cloudformation",
    "describe-stacks",
    "--stack-name",
    stack,
    "--query",
    `Stacks[0].Parameters[?ParameterKey=='${key}'].ParameterValue`,
    "--output",
    "text",
  );
  return out?.trim() || null;
};
const outputs = (stack) =>
  Object.fromEntries(
    (
      JSON.parse(aws("cloudformation", "describe-stacks", "--stack-name", stack, "--query", "Stacks[0].Outputs", "--output", "json")) ?? []
    ).map((o) => [o.OutputKey, o.OutputValue]),
  );

console.log(`Stage: ${stage.name} (${stage.siteUrl}), Square ${stage.squareEnv}`);

// --- the token must already be in SSM -----------------------------------------------------------
step(`Square token parameter ${stage.squareTokenParam}`);
if (
  !tryAws(
    "ssm",
    "describe-parameters",
    "--parameter-filters",
    `Key=Name,Values=${stage.squareTokenParam}`,
    "--query",
    "Parameters[0].Name",
    "--output",
    "text",
  )?.includes(stage.squareTokenParam)
)
  throw new Error(`No SSM parameter ${stage.squareTokenParam}. Run: npm run put-token -- --stage ${stage.name}`);
console.log("present (SecureString; not read here)");

const account = JSON.parse(aws("sts", "get-caller-identity", "--output", "json")).Account;
const artifacts = `updraft-artifacts-${account}`;

// --- package the Lambda bundle ------------------------------------------------------------------
step(`Artifact bucket ${artifacts}`);
if (tryAws("s3api", "head-bucket", "--bucket", artifacts) === null) {
  aws("s3", "mb", `s3://${artifacts}`);
  aws(
    "s3api",
    "put-public-access-block",
    "--bucket",
    artifacts,
    "--public-access-block-configuration",
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true",
  );
  console.log("created (private)");
} else console.log("exists");

// Bundle handler + Square SDK into one file; template.yaml's CodeUri points at this folder only.
// The AWS SDK (used to read the token from SSM) comes with the Lambda runtime, so it stays out.
step("Bundling");
const BUILD = path.join(BACKEND, ".build");
rmSync(BUILD, { recursive: true, force: true });
await esbuild.build({
  entryPoints: [path.join(BACKEND, "src", "handler.mjs")],
  outfile: path.join(BUILD, "index.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  minify: true,
  legalComments: "none",
  external: ["@aws-sdk/*"],
  // The Square SDK uses require() internally; give the ES module bundle a real one.
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  logLevel: "info",
});

// The photo function (images.mjs): its own small bundle, plus sharp. sharp is a native module, so it
// is installed for Lambda's Linux x64 whichever machine deploys, at the version the site build uses.
const BUILD_IMAGES = path.join(BACKEND, ".build-images");
rmSync(BUILD_IMAGES, { recursive: true, force: true });
await esbuild.build({
  entryPoints: [path.join(BACKEND, "src", "images.mjs")],
  outfile: path.join(BUILD_IMAGES, "index.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  minify: true,
  legalComments: "none",
  external: ["sharp"],
  logLevel: "info",
});
const sharpVersion = JSON.parse(readFileSync(path.join(ROOT, "node_modules", "sharp", "package.json"), "utf8")).version;
// Run npm without a shell where we can: as an npm script, npm_execpath is its own CLI (a shell on
// Windows is deprecated by Node, since it concatenates the arguments).
const npmArgs = [
  "install",
  `sharp@${sharpVersion}`,
  "--prefix",
  BUILD_IMAGES,
  "--os=linux",
  "--cpu=x64",
  "--libc=glibc",
  "--no-save",
  "--no-package-lock",
  "--no-audit",
  "--no-fund",
];
/** @type {import("node:child_process").ExecFileSyncOptions} */
const quiet = { stdio: ["ignore", "ignore", "inherit"] };
if (process.env.npm_execpath) execFileSync(process.execPath, [process.env.npm_execpath, ...npmArgs], quiet);
else execFileSync("npm", npmArgs, { ...quiet, shell: process.platform === "win32" });
console.log(`sharp ${sharpVersion} for linux-x64 installed`);

// Guard, before anything is uploaded: code may only ever come from these fresh build folders. A
// CodeUri pointing anywhere else makes `package` zip that folder instead; once it zipped the whole
// backend folder, .env and its token included.
step("Checking code folders");
const BUILDS = { ".build": BUILD, ".build-images": BUILD_IMAGES };
const codeUris = [...readFileSync(path.join(BACKEND, "template.yaml"), "utf8").matchAll(/^\s*CodeUri:\s*(\S+)/gm)].map((m) => m[1]);
if (!codeUris.length || codeUris.some((u) => !Object.hasOwn(BUILDS, u)))
  throw new Error(`backend/template.yaml CodeUri must be one of ${Object.keys(BUILDS).join(", ")}; found ${codeUris.join(", ")}`);
for (const dir of Object.values(BUILDS)) {
  const secret = readdirSync(dir, { recursive: true }).find((f) => /(^|[\\/])\.env/.test(String(f)));
  if (secret) throw new Error(`${path.join(dir, String(secret))} must never be packaged; refusing to deploy.`);
}
console.log(`CodeUri ${codeUris.join(", ")}: build folders only, no .env files`);

step("Packaging");
const packaged = path.join(BACKEND, "packaged.yaml");
aws(
  "cloudformation",
  "package",
  "--template-file",
  path.join(BACKEND, "template.yaml"),
  "--s3-bucket",
  artifacts,
  "--s3-prefix",
  stage.apiStack,
  "--output-template-file",
  packaged,
);

// Guard, after upload: no package may be unexpectedly large (the API bundle is ~0.5 MB, the photo
// function with sharp ~10 MB). Anything bigger is deleted and nothing deploys.
step("Checking packaged code");
const MAX_PACKAGE = 40 * 1024 * 1024;
const uris = [...new Set([...readFileSync(packaged, "utf8").matchAll(/CodeUri:\s*(s3:\/\/\S+)/g)].map((m) => m[1]))];
if (!uris.length) throw new Error("No packaged CodeUri found; refusing to deploy.");
for (const uri of uris) {
  const [, bucketName, key] = uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  const size = Number(aws("s3api", "head-object", "--bucket", bucketName, "--key", key, "--query", "ContentLength", "--output", "text"));
  if (size > MAX_PACKAGE) {
    aws("s3", "rm", uri);
    rmSync(packaged, { force: true });
    throw new Error(
      `Packaged code ${uri} is ${(size / 1048576).toFixed(1)} MB, far more than the builds; deleted it. Check backend/template.yaml.`,
    );
  }
  console.log(`${uri}: ${(size / 1024).toFixed(0)} KB ok`);
}

// --- deploy -----------------------------------------------------------------------------------
const apiParams = () => ({
  SquareTokenParam: stage.squareTokenParam,
  SquareLocationId: stage.squareLocationId,
  SquareEnv: stage.squareEnv,
  ShippingCents: String(stage.shippingCents),
  SiteOrigin: stage.siteUrl,
  NewsletterGroupId: stage.newsletterGroupId,
  ApiConcurrency: String(stage.apiConcurrency),
  AlertEmail: stage.alertEmail,
});
const deployApi = () => {
  step(`Deploying ${stage.apiStack} (function URLs accept only CloudFront)`);
  aws(
    "cloudformation",
    "deploy",
    "--template-file",
    packaged,
    "--stack-name",
    stage.apiStack,
    "--capabilities",
    "CAPABILITY_IAM",
    "CAPABILITY_AUTO_EXPAND",
    "--no-fail-on-empty-changeset",
    "--parameter-overrides",
    ...Object.entries(apiParams()).map(([k, v]) => `${k}=${v}`),
  );
};

const deploySite = (api) => {
  step(`Routing ${stage.siteStack}: /api/checkout -> ${api.CheckoutFunction}, /api/* -> ${api.ApiFunction}`);
  aws(
    "cloudformation",
    "deploy",
    "--template-file",
    path.join(ROOT, "deploy", "site.yaml"),
    "--stack-name",
    stage.siteStack,
    "--no-fail-on-empty-changeset",
    "--parameter-overrides",
    `DomainName=${stage.domain}`,
    `IncludeWww=${stage.includeWww}`,
    `ManageDns=${stage.manageDns}`,
    `NameSuffix=${stage.name === "prod" ? "" : `-${stage.name}`}`,
    `ApiDomain=${new URL(api.ApiUrl).host}`,
    `CheckoutDomain=${new URL(api.CheckoutUrl).host}`,
    `ApiFunctionName=${api.ApiFunction}`,
    `CheckoutFunctionName=${api.CheckoutFunction}`,
    `ImagesDomain=${api.ImagesUrl ? new URL(api.ImagesUrl).host : ""}`, // none on an older stack until its first deploy
    `ImagesFunctionName=${api.ImagesFunction ?? ""}`,
  );
};

// The API stack as it is now (null if it doesn't exist yet). Older stacks have no function-name
// outputs, so those come from the stack's resources.
function currentApi() {
  const o = stackParam(stage.apiStack, "SquareLocationId") === null ? {} : outputs(stage.apiStack);
  if (!o.ApiUrl || !o.CheckoutUrl) return null;
  const fn = (id) =>
    o[`${id}Function`] ??
    aws(
      "cloudformation",
      "describe-stack-resource",
      "--stack-name",
      stage.apiStack,
      "--logical-resource-id",
      id,
      "--query",
      "StackResourceDetail.PhysicalResourceId",
      "--output",
      "text",
    ).trim();
  return { ApiUrl: o.ApiUrl, CheckoutUrl: o.CheckoutUrl, ApiFunction: fn("Api"), CheckoutFunction: fn("Checkout") };
}
const urlAuthType = (fn) =>
  tryAws("lambda", "get-function-url-config", "--function-name", fn, "--query", "AuthType", "--output", "text")?.trim();

// Locking public URLs (an older stack): CloudFront must be signing, and be allowed in, before the
// URLs switch to AWS_IAM. So the site goes first; public URLs ignore the signature, so the shop keeps
// working. Then the API deploy flips the URLs to AWS_IAM, which CloudFront's permission (made for
// AWS_IAM) covers at once; the old public permissions are removed only after that, in cleanup.
const before = currentApi();
const unlocked = before && [before.ApiFunction, before.CheckoutFunction].some((f) => urlAuthType(f) !== "AWS_IAM");
try {
  if (unlocked) {
    console.log("\nFunction URLs are public now: letting CloudFront sign first, then locking them.");
    deploySite(before);
  }
  deployApi();
  deploySite(outputs(stage.apiStack)); // no change unless a URL or function name changed
} finally {
  rmSync(packaged, { force: true });
}

const site = outputs(stage.siteStack);
console.log(
  `\nDone. ${stage.siteUrl} (CloudFront ${site.DistributionId}). Publish the site with: npm run publish -- --stage ${stage.name}`,
);
if (stage.alertEmail) console.log(`Alarms email ${stage.alertEmail}; confirm the SNS subscription email the first time.`);
