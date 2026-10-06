// Browser settings. The Square IDs here are public values; they come from deploy/stages.json for the
// stage being built (scripts/build.mjs defines __SITE_CONFIG__). The access token never reaches the browser.
export const config = {
  apiBase: "", // same origin: CloudFront routes /api/* to the Lambda functions
  ...__SITE_CONFIG__, // squareEnv, squareAppId, squareLocationId, shippingCents
};
