// Names the browser code uses that TypeScript can't see on its own (checked by `npm run typecheck`).

/** Public per-stage settings, injected by scripts/build.mjs from deploy/stages.json. */
declare const __SITE_CONFIG__: {
  squareEnv: "sandbox" | "production";
  squareAppId: string;
  squareLocationId: string;
  shippingCents: number;
};

interface Window {
  /** Square Web Payments SDK, loaded at runtime once the cart has something in it. */
  Square: any;
}
