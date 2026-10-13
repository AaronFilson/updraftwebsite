// Stores the Square access token in SSM Parameter Store (SecureString) for a stage, where the Lambda
// functions read it. The token is taken from SQUARE_ACCESS_TOKEN, else backend/.env (sandbox stages) or a
// hidden prompt (production; see scripts/square-client.mjs). It is never printed, and reaches the AWS CLI
// in a temporary file that is deleted straight after.
//   npm run put-token                     production
//   npm run put-token -- --stage staging  staging
import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { currentStage } from "./stage.mjs";
import { squareToken } from "./square-client.mjs";

const stage = currentStage();

const token = await squareToken(stage);
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
