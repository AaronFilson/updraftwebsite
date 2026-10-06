// Which stage a script works on: --stage <name> or STAGE, default prod. Settings come from
// deploy/stages.json (no secrets there; the Square token lives in SSM).
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const stages = JSON.parse(readFileSync(path.join(ROOT, "deploy", "stages.json"), "utf8"));

export function currentStage(argv = process.argv) {
  const i = argv.indexOf("--stage");
  const name = (i >= 0 ? argv[i + 1] : process.env.STAGE) || "prod";
  if (!stages[name]) throw new Error(`Unknown stage "${name}"; known: ${Object.keys(stages).join(", ")}`);
  return { name, ...stages[name], siteUrl: `https://${stages[name].domain}` };
}
