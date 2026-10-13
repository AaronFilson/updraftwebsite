// A Square client for scripts that change the catalog, for the Square environment of the stage.
// The token comes from SQUARE_ACCESS_TOKEN; for sandbox stages backend/.env is used if that's unset.
// A production stage never falls back to backend/.env, which holds the sandbox token.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");

export async function squareClient(stage) {
  const production = stage.squareEnv === "production";
  let token = process.env.SQUARE_ACCESS_TOKEN;
  const envFile = path.join(ROOT, "backend", ".env");
  if (!token && !production && existsSync(envFile))
    token = readFileSync(envFile, "utf8")
      .match(/^\s*SQUARE_ACCESS_TOKEN\s*=\s*['"]?([^'"\r\n]+)/m)?.[1]
      ?.trim();
  if (!token)
    throw new Error(
      production
        ? `Stage "${stage.name}" uses Square production: set SQUARE_ACCESS_TOKEN to the production token first.`
        : "No token: set SQUARE_ACCESS_TOKEN or put it in backend/.env (git-ignored).",
    );
  // The Square SDK is a backend dependency.
  const sdk = createRequire(path.join(ROOT, "backend", "package.json")).resolve("square");
  const { SquareClient, SquareEnvironment } = await import(pathToFileURL(sdk).href);
  return new SquareClient({ token, environment: production ? SquareEnvironment.Production : SquareEnvironment.Sandbox });
}

// Square's errors carry the useful part in .body; a wrong-environment token shows up as UNAUTHORIZED.
export function squareErrorMessage(err) {
  const first = err?.errors?.[0] ?? err?.body?.errors?.[0];
  if (first?.code === "UNAUTHORIZED")
    return "Square refused the token (UNAUTHORIZED). Check it's the token for this stage's Square environment (sandbox or production).";
  return first ? `${first.code}: ${first.detail ?? ""}` : (err?.message ?? String(err));
}
