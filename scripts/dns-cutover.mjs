// Points updraftpotterystudio.com and www at the CloudFront distribution (UPSERT, so there is no gap).
//   node scripts/dns-cutover.mjs              switch to CloudFront (A + AAAA alias records)
//   node scripts/dns-cutover.mjs --rollback   point A back at the old us-west-2 S3 website, remove AAAA
//   add --dry-run to print the change batch without applying it
import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const STACK = process.env.STACK ?? "updraft-site";
const DOMAIN = "updraftpotterystudio.com";
const ZONE = "Z88UBBDI22ZJ9";
const CLOUDFRONT_ZONE = "Z2FDTNDATAQYW2"; // fixed hosted zone id for every CloudFront alias
const S3_WEBSITE_USW2 = { zone: "Z3BJ6K6RIION7M", dns: "s3-website-us-west-2.amazonaws.com." }; // the old site
const rollback = process.argv.includes("--rollback");
const dry = process.argv.includes("--dry-run");

const aws = (...args) => execFileSync("aws", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const names = [`${DOMAIN}.`, `www.${DOMAIN}.`];
const alias = (name, type, target) => ({
  Action: "UPSERT",
  ResourceRecordSet: { Name: name, Type: type, AliasTarget: { HostedZoneId: target.zone, DNSName: target.dns, EvaluateTargetHealth: false } },
});

let changes;
if (rollback) {
  const current = JSON.parse(aws("route53", "list-resource-record-sets", "--hosted-zone-id", ZONE, "--output", "json")).ResourceRecordSets;
  changes = [
    ...names.map((n) => alias(n, "A", S3_WEBSITE_USW2)),
    ...current.filter((r) => r.Type === "AAAA" && names.includes(r.Name)).map((r) => ({ Action: "DELETE", ResourceRecordSet: r })),
  ];
} else {
  const outputs = Object.fromEntries(JSON.parse(aws("cloudformation", "describe-stacks", "--stack-name", STACK,
    "--query", "Stacks[0].Outputs", "--output", "json")).map((o) => [o.OutputKey, o.OutputValue]));
  const cf = { zone: CLOUDFRONT_ZONE, dns: `${outputs.DistributionDomain}.` };
  changes = names.flatMap((n) => [alias(n, "A", cf), alias(n, "AAAA", cf)]);
}

const batch = { Comment: rollback ? "Roll back to old S3 website" : "Switch to CloudFront", Changes: changes };
console.log(JSON.stringify(batch, null, 2));
if (dry) process.exit(0);

const file = path.join(tmpdir(), `updraft-dns-${Date.now()}.json`);
writeFileSync(file, JSON.stringify(batch));
try {
  const out = JSON.parse(aws("route53", "change-resource-record-sets", "--hosted-zone-id", ZONE, "--change-batch", `file://${file}`, "--output", "json"));
  console.log(`\nSubmitted ${out.ChangeInfo.Id} (${out.ChangeInfo.Status}). Route 53 applies it within about a minute.`);
} finally {
  rmSync(file, { force: true });
}
