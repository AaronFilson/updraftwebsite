// Settings from the Lambda environment, and the Square client.
// The access token lives in SSM Parameter Store (SecureString, SQUARE_TOKEN_PARAM) and is read once per
// cold start; SQUARE_ACCESS_TOKEN is only for local runs and tests.
import { SquareClient, SquareEnvironment } from "square";

export const {
  SQUARE_LOCATION_ID,
  SQUARE_ENV = "sandbox",
  SHIPPING_CENTS = "0",
  ALLOWED_ORIGIN = "*",
  NEWSLETTER_GROUP_ID = "",
} = process.env;

let tokenPromise;
export function squareToken() {
  const param = process.env.SQUARE_TOKEN_PARAM;
  if (!param) return Promise.resolve(process.env.SQUARE_ACCESS_TOKEN);
  tokenPromise ??= (async () => {
    // The AWS SDK ships with the Lambda runtime; it is left out of the bundle (scripts/deploy-api.mjs).
    const { SSMClient, GetParameterCommand } = await import("@aws-sdk/client-ssm");
    const out = await new SSMClient({}).send(new GetParameterCommand({ Name: param, WithDecryption: true }));
    return out.Parameter.Value;
  })().catch((err) => {
    tokenPromise = undefined;
    throw err;
  }); // retry on the next request
  return tokenPromise;
}

let client;
const onReset = new Set();
export const square = () =>
  (client ??= new SquareClient({
    token: squareToken,
    environment: SQUARE_ENV === "production" ? SquareEnvironment.Production : SquareEnvironment.Sandbox,
  }));

// For tests: swap in a fake client and clear anything cached from the previous one.
export const _setSquare = (fake) => {
  client = fake;
  for (const fn of onReset) fn();
};
export const onSquareReset = (fn) => onReset.add(fn);
