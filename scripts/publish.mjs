// Builds and publishes the site to the updraft-site stack (S3 + CloudFront).
//   npm run publish                       production: build, upload, invalidate
//   npm run publish -- --stage staging    staging (staging.updraftpotterystudio.com)
//   npm run publish -- --dry-run          show what would change without uploading
// Uses the default AWS CLI profile (copper-bell); set AWS_PROFILE to use another.
// Order matters: content-hashed files go up first (cached for a year), then HTML (5 minutes),
// and only then are files no longer in the build removed, so a cached page never points at
// a deleted asset.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { currentStage } from "./stage.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIST = path.join(ROOT, "dist");
const stage = currentStage();
const STACK = stage.siteStack;
const SITE_URL = stage.siteUrl;
const DRY = process.argv.includes("--dry-run");

const aws = (...args) => execFileSync("aws", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

const outputs = Object.fromEntries(
  JSON.parse(aws("cloudformation", "describe-stacks", "--stack-name", STACK, "--query", "Stacks[0].Outputs", "--output", "json")).map(
    (o) => [o.OutputKey, o.OutputValue],
  ),
);
const bucket = `s3://${outputs.BucketName}`;
console.log(`Publishing to ${bucket} (CloudFront ${outputs.DistributionId}) as ${SITE_URL}${DRY ? " [dry run]" : ""}`);

execFileSync(process.execPath, [path.join(ROOT, "scripts", "build.mjs")], {
  stdio: "inherit",
  cwd: ROOT,
  env: { ...process.env, SITE_URL, STAGE: stage.name },
});

const YEAR = "public,max-age=31536000,immutable";
const SHORT = "public,max-age=300";
const sync = (label, ...args) => {
  console.log(`\n== ${label}`);
  const out = aws("s3", "sync", DIST, bucket, "--no-progress", ...(DRY ? ["--dryrun"] : []), ...args);
  process.stdout.write(out || "  (no changes)\n");
};
const hashed = ["--exclude", "*", "--include", "assets/*", "--include", "img/*", "--include", "full/*"];

// 1. Content-hashed files. JS and AVIF get explicit types: the CLI guesses types from the OS, and on
//    Windows it labels .js as text/plain, which browsers refuse to run as a module (nosniff is on).
sync("hashed assets", ...hashed, "--exclude", "*.avif", "--exclude", "*.js", "--cache-control", YEAR);
sync("hashed assets (js)", "--exclude", "*", "--include", "assets/*.js", "--content-type", "text/javascript", "--cache-control", YEAR);
sync(
  "hashed assets (avif)",
  "--exclude",
  "*",
  "--include",
  "img/*.avif",
  "--include",
  "img/*/*.avif",
  "--content-type",
  "image/avif",
  "--cache-control",
  YEAR,
);
// 2. Everything else: HTML, favicon, manifest, robots, sitemap.
sync("pages", "--exclude", "assets/*", "--exclude", "img/*", "--exclude", "full/*", "--exclude", "*.webmanifest", "--cache-control", SHORT);
sync("manifest", "--exclude", "*", "--include", "*.webmanifest", "--content-type", "application/manifest+json", "--cache-control", SHORT);
// 3. Remove anything that is no longer part of the build.
sync("remove old files", "--delete", "--size-only");

if (!DRY) {
  const id = JSON.parse(
    aws("cloudfront", "create-invalidation", "--distribution-id", outputs.DistributionId, "--paths", "/*", "--output", "json"),
  ).Invalidation.Id;
  console.log(`\nInvalidation ${id} started; changes are live within a few minutes.`);
  console.log(`Test URL: https://${outputs.DistributionDomain}/`);
}
