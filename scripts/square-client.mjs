// A Square client for scripts that change the catalog, for the Square environment of the stage.
// The token comes from SQUARE_ACCESS_TOKEN if set. Otherwise a sandbox stage reads backend/.env, and a
// production stage asks for it with hidden typing, so it never appears on screen, in a command or in
// the shell's history. backend/.env holds the sandbox token, so production never reads it.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");

const PASTE_MARKS = new RegExp(`${String.fromCharCode(27)}\\[20[01]~`, "g"); // ESC [200~ and ESC [201~

/** Reads one line from the terminal without echoing it. */
function askHidden(question) {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) return Promise.reject(new Error("No terminal to ask for the token in: set SQUARE_ACCESS_TOKEN instead."));
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
    };
    const onData = (chunk) => {
      // Terminals may wrap a paste in bracketed-paste markers; drop them.
      for (const ch of chunk.replace(PASTE_MARKS, "")) {
        if (ch === "\r" || ch === "\n") {
          finish();
          return resolve(value.trim());
        }
        if (ch === "\u0003") {
          finish();
          return reject(new Error("Cancelled. Nothing was changed."));
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    stdin.resume();
  });
}

/** The Square access token for this stage (see the top of this file). */
export async function squareToken(stage) {
  if (process.env.SQUARE_ACCESS_TOKEN) return process.env.SQUARE_ACCESS_TOKEN.trim();
  if (stage.squareEnv === "production") {
    const token = await askHidden(
      `Paste the Square PRODUCTION access token for stage "${stage.name}", then press Enter (nothing shows while you paste): `,
    );
    if (!/^\S{20,}$/.test(token))
      throw new Error("That doesn't look like an access token (no spaces, at least 20 characters). Nothing was changed.");
    return token;
  }
  const envFile = path.join(ROOT, "backend", ".env");
  const token = existsSync(envFile)
    ? readFileSync(envFile, "utf8")
        .match(/^\s*SQUARE_ACCESS_TOKEN\s*=\s*['"]?([^'"\r\n]+)/m)?.[1]
        ?.trim()
    : undefined;
  if (!token) throw new Error("No token: set SQUARE_ACCESS_TOKEN or put it in backend/.env (git-ignored).");
  return token;
}

export async function squareClient(stage) {
  const token = await squareToken(stage);
  // The Square SDK is a backend dependency.
  const sdk = createRequire(path.join(ROOT, "backend", "package.json")).resolve("square");
  const { SquareClient, SquareEnvironment } = await import(pathToFileURL(sdk).href);
  const production = stage.squareEnv === "production";
  return new SquareClient({ token, environment: production ? SquareEnvironment.Production : SquareEnvironment.Sandbox });
}

// Square's errors carry the useful part in .body; a wrong-environment token shows up as UNAUTHORIZED.
export function squareErrorMessage(err) {
  const first = err?.errors?.[0] ?? err?.body?.errors?.[0];
  if (first?.code === "UNAUTHORIZED")
    return "Square refused the token (UNAUTHORIZED). Check it's the token for this stage's Square environment (sandbox or production).";
  return first ? `${first.code}: ${first.detail ?? ""}` : (err?.message ?? String(err));
}

// Try the hidden prompt without touching Square or AWS: node scripts/square-client.mjs --try-prompt
// It only reports how many characters arrived (a production token is about 64).
if (import.meta.url === pathToFileURL(process.argv[1]).href && process.argv.includes("--try-prompt")) {
  try {
    const typed = await askHidden("Paste anything (a test; it isn't stored), then press Enter: ");
    console.log(`Got ${typed.length} characters; nothing showed on screen and nothing was stored.`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
