// Fill these in after creating the Square application and deploying the backend (see README).
// The application ID and location ID are public values; the access token must NEVER go here.
export const config = {
  apiBase: "",                 // empty = same origin: CloudFront routes /api/* to the Lambda (npm run deploy:api)
  squareEnv: "sandbox",        // "sandbox" or "production"
  squareAppId: "sandbox-sq0idb-1vOeswd-22qg74POomdy9Q", // Square Developer Console > your app > Credentials
  squareLocationId: "LVD23T0RKJF05",                    // Square Developer Console > your app > Locations
  shippingCents: 0,            // must match SHIPPING_CENTS on the backend (display only)
};
