// Stores the Square access token in SSM Parameter Store (SecureString) for a stage, where the Lambda
// functions read it. The token is taken from SQUARE_ACCESS_TOKEN or backend/.env, never printed, and
// passed to the AWS CLI in a temporary file that is deleted straight after.
//   npm run put-token                     production
//   npm run put-token -- --stage staging  staging
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { currentStage } from "./stage.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const stage = currentStage();

let token = process.env.SQUARE_ACCESS_TOKEN;
const envFile = path.join(ROOT, "backend", ".env");
if (!token && existsSync(envFile))
  token = readFileSync(envFile, "utf8")
    .match(/^\s*SQUARE_ACCESS_TOKEN\s*=\s*['"]?([^'"\r\n]+)/m)?.[1]
    ?.trim();
if (!token) throw new Error("No token: set SQUARE_ACCESS_TOKEN or put it in backend/.env (git-ignored).");
if (stage.squareEnv === "sandbox" && !token.startsWith("EAAA")) console.warn("Note: sandbox access tokens usually start with EAAA.");

const file = path.join(tmpdir(), `updraft-token-${process.pid}.json`);
writeFileSync(file, JSON.stringify({ Name: stage.squareTokenParam, Value: token, Type: "SecureString", Overwrite: true }), { mode: 0o600 });
try {
  execFileSync("aws", ["ssm", "put-parameter", "--cli-input-json", `file://${file}`], { stdio: ["ignore", "ignore", "inherit"] });
} finally {
  rmSync(file, { force: true });
}
console.log(
  `Stored ${stage.squareTokenParam} (SecureString, ${token.length} characters). Functions pick it up on their next cold start; redeploy to refresh now.`,
);
