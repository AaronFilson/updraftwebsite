// What shipping costs for an order. Every piece is double-boxed and sent on its own, so the charge is
// the sum of one label per piece: the carrier's published rate for the piece's billed weight (set on
// the item in Square) and the zone of the delivery ZIP, rounded up to whole dollars.
// UPS Ground carries everything it can; USPS carries what UPS doesn't deliver to (PO boxes, military
// addresses, Alaska, Hawaii and the territories).
import RATES from "./shipping-rates.json" with { type: "json" };

// Places UPS Ground doesn't reach: Alaska, Hawaii, territories and freely associated states, military.
const USPS_ONLY_STATES = new Set(["AK", "HI", "PR", "VI", "GU", "AS", "MP", "FM", "MH", "PW", "AA", "AE", "AP"]);
const PO_BOX_RE = /\b(p\.?\s*o\.?\s*box|post\s+office\s+box)\b/i;

/** Which carrier takes a parcel to this address. @param {{state: string, line1?: string, line2?: string}} a */
export function carrierFor(a) {
  if (USPS_ONLY_STATES.has(a.state.toUpperCase())) return "usps";
  if (PO_BOX_RE.test(`${a.line1 ?? ""} ${a.line2 ?? ""}`)) return "usps";
  return "ups";
}

/** Zone from our origin (ZIP prefix 984) to a 5-digit ZIP, or null if the ZIP isn't on the chart. */
export function zoneFor(postalCode) {
  const p = String(postalCode).slice(0, 3);
  const row = RATES.zones.find(([lo, hi]) => p >= lo && p <= hi);
  return row ? row[2] : null;
}

// table = [[lb, dollars], ...] ascending, for the weights the rate guides were read at; weights in
// between are interpolated. Nothing past the last row is priced (null): those parcels need a quote.
function priceAtWeight(table, lb) {
  if (lb <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (lb <= table[i][0]) {
      const [x0, y0] = table[i - 1];
      const [x1, y1] = table[i];
      return y0 + ((y1 - y0) * (lb - x0)) / (x1 - x0);
    }
  }
  return null;
}

/** Published label price in dollars (to the cent) for one parcel, or null if it's past the rate table. */
export function labelDollars(/** @type {"ups"|"usps"} */ carrier, zone, lb) {
  // Tables cover zones 2-8: UPS Ground starts at zone 2, and USPS prices zone 1 as 2 and zone 9 as 8.
  const z = String(Math.min(8, Math.max(2, zone)));
  const billed = Math.ceil(lb);
  const base = priceAtWeight(RATES[carrier].rates[z], billed);
  if (base === null) return null;
  const dollars = carrier === "ups" ? (base + RATES.ups.residential) * (1 + RATES.ups.fuelPct / 100) : base;
  return Math.round(dollars * 100) / 100;
}

/**
 * Shipping charge in cents for parcels of the given billed weights, or an error message.
 * @param {number[]} weights billed weight in lb of each parcel (one per piece)
 * @param {{state: string, postalCode: string, line1?: string, line2?: string}} address
 */
export function shippingCents(weights, address) {
  const zone = zoneFor(address.postalCode);
  if (zone === null) return { error: "We can't ship to that ZIP code. Please check it, or choose pickup." };
  const carrier = carrierFor(address);
  const labels = weights.map((lb) => labelDollars(carrier, zone, lb));
  if (labels.includes(null))
    return { error: "A piece in your cart is too heavy to price online. Please email for a shipping quote, or choose pickup." };
  const cents = labels.reduce((sum, d) => sum + Math.round(d * 100), 0); // whole cents, so no float error reaches the ceiling
  return { cents: Math.ceil(cents / 100) * 100, carrier, zone };
}
