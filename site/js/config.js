// Fill these in after creating the Square application and deploying the backend (see README).
// The application ID and location ID are public values; the access token must NEVER go here.
export const config = {
  apiBase: "",                 // e.g. "https://abc123.execute-api.us-west-2.amazonaws.com" (empty = same origin /api via CloudFront)
  squareEnv: "sandbox",        // "sandbox" or "production"
  squareAppId: "",             // Square Developer Dashboard > your app > Credentials
  squareLocationId: "",        // Square Dashboard > Account & Settings > Locations
  shippingCents: 0,            // must match SHIPPING_CENTS on the backend (display only)
};
