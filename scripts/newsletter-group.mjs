// Finds the "Website newsletter" customer group in a stage's Square account, creating it if missing,
// and prints its id for newsletterGroupId in deploy/stages.json. Email signups are added to it.
//   node scripts/newsletter-group.mjs                    production (asks for the token, hidden)
//   node scripts/newsletter-group.mjs --stage staging    staging
import { randomUUID } from "node:crypto";
import { currentStage } from "./stage.mjs";
import { squareClient, squareErrorMessage } from "./square-client.mjs";

const NAME = "Website newsletter";
const stage = currentStage();

try {
  const square = await squareClient(stage);
  let group;
  for await (const g of await square.customers.groups.list()) if (g.name === NAME) group = g;
  if (!group) ({ group } = await square.customers.groups.create({ idempotencyKey: randomUUID(), group: { name: NAME } }));
  console.log(`"${NAME}" in Square ${stage.squareEnv}: ${group.id}`);
  if (group.id !== stage.newsletterGroupId)
    console.log(
      `Set "newsletterGroupId": "${group.id}" for "${stage.name}" in deploy/stages.json, then run npm run deploy:api${stage.name === "prod" ? "" : ` -- --stage ${stage.name}`}.`,
    );
  else console.log("deploy/stages.json already has this id.");
} catch (err) {
  console.error(squareErrorMessage(err));
  process.exitCode = 1;
}
