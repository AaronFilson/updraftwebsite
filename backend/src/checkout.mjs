// POST /api/quote and POST /api/checkout. Prices always come from Square, never from the browser.
// Checkout authorises the card, re-checks stock, then completes the charge or releases the hold.
import { randomUUID } from "node:crypto";
import { SQUARE_LOCATION_ID, SHIPPING_CENTS, square } from "./config.mjs";
import { respond, EMAIL_RE } from "./http.mjs";
import { checkStock, unknownLines } from "./catalog.mjs";
import { recordSale } from "./stock.mjs";

const MAX_LINES = 20;
const MAX_QTY = 10;

const soldResponse = (sold) =>
  respond(409, {
    errors: [`Sorry, ${sold.map((x) => x.name).join(" and ")} just sold.`],
    sold: sold.map((x) => x.variationId),
    notCharged: true,
  });

const ZIP_RE = /^\d{5}(-\d{4})?$/;
const STATE_RE = /^[A-Za-z]{2}$/;
const text = (v, max = 100) => (typeof v === "string" ? v.trim().slice(0, max) : "");

function validateLines(b, errors) {
  if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > MAX_LINES) errors.push("Cart is empty or too large.");
  for (const l of b.lines ?? []) {
    if (typeof l.variationId !== "string" || !Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > MAX_QTY)
      errors.push("Invalid cart line.");
  }
  // One line per piece, so the stock check sees the full quantity asked for.
  if (Array.isArray(b.lines) && new Set(b.lines.map((l) => l?.variationId)).size !== b.lines.length)
    errors.push("Each piece can only appear once in the cart.");
  if (b.fulfillment !== "shipping" && b.fulfillment !== "pickup") errors.push("Choose pickup or shipping.");
}

// US addresses only for now. `who` names the address in error messages.
function cleanAddress(a, who, errors, { needName = false } = {}) {
  a ??= {};
  const out = {
    name: text(a.name),
    line1: text(a.line1),
    line2: text(a.line2),
    city: text(a.city, 60),
    state: text(a.state, 20).toUpperCase(),
    postalCode: text(a.postalCode, 20), // long enough that bad input fails the checks below
  };
  if ((needName && !out.name) || !out.line1 || !out.city || !STATE_RE.test(out.state) || !ZIP_RE.test(out.postalCode))
    errors.push(`Complete ${who} address required.`);
  return out;
}

// Square wants 9-16 digits; normalise US numbers to E.164 and drop anything unusable.
function cleanPhone(v) {
  const digits = String(v ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits.length >= 9 && digits.length <= 16 ? `+${digits}` : undefined;
}

// Customer's order note: plain text, up to 500 characters (Square's payment-note limit), no control
// characters other than line breaks.
export const cleanNote = (v) =>
  typeof v === "string"
    ? v
        .replace(/[^\S\n]+/g, " ")
        // eslint-disable-next-line no-control-regex -- stripping control characters is the point
        .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, 500)
    : "";

const splitName = (full) => {
  const [first, ...rest] = full.trim().split(/\s+/);
  return { first, last: rest.join(" ") || undefined };
};
const squareAddress = (a, name) => {
  const { first, last } = splitName(name);
  return {
    addressLine1: a.line1,
    addressLine2: a.line2 || undefined,
    locality: a.city,
    administrativeDistrictLevel1: a.state,
    postalCode: a.postalCode,
    country: "US",
    firstName: first,
    lastName: last,
  };
};

// The parts of the order that decide its price; shared by /api/quote and /api/checkout so they always agree.
function priceableOrder(b) {
  const shipping = Number(SHIPPING_CENTS);
  return {
    locationId: SQUARE_LOCATION_ID,
    lineItems: b.lines.map((l) => ({ catalogObjectId: l.variationId, quantity: String(l.quantity) })),
    pricingOptions: { autoApplyTaxes: true },
    serviceCharges:
      b.fulfillment === "shipping" && shipping > 0
        ? [{ name: "Shipping", amountMoney: { amount: BigInt(shipping), currency: "USD" }, calculationPhase: "SUBTOTAL_PHASE" }]
        : undefined,
  };
}

// Tax and total for the cart, before paying. Nothing is created in Square.
export async function quote(b) {
  const errors = [];
  validateLines(b, errors);
  if (errors.length) return respond(400, { errors });
  if (await unknownLines(b.lines)) return respond(400, { errors: ["An item is no longer available."] });
  const sold = await checkStock(b.lines);
  if (sold.length) return soldResponse(sold);
  const { order } = await square().orders.calculate({ order: priceableOrder(b) });
  return respond(200, {
    subtotal:
      Number(order.totalMoney.amount) - Number(order.totalTaxMoney?.amount ?? 0) - Number(order.totalServiceChargeMoney?.amount ?? 0),
    shipping: Number(order.totalServiceChargeMoney?.amount ?? 0),
    tax: Number(order.totalTaxMoney?.amount ?? 0),
    total: Number(order.totalMoney.amount),
  });
}

function validateCheckout(b) {
  const errors = [];
  validateLines(b, errors);
  if (typeof b.sourceId !== "string" || !b.sourceId) errors.push("Missing payment token.");
  if (!EMAIL_RE.test(b.email ?? "")) errors.push("A valid email is required.");
  if (!text(b.name)) errors.push("Name is required.");
  // Every order paid on the site needs a billing address; shipped orders also need where to send it.
  const billing = cleanAddress(b.billing, "billing", errors);
  const shipping = b.fulfillment === "shipping" ? cleanAddress(b.shipping, "shipping", errors, { needName: true }) : null;
  return { errors, billing, shipping };
}

export async function checkout(b) {
  const { errors, billing, shipping } = validateCheckout(b);
  if (errors.length) return respond(400, { errors });
  if (await unknownLines(b.lines)) return respond(400, { errors: ["An item is no longer available."] });
  const name = text(b.name);
  const phone = cleanPhone(b.phone);
  const note = cleanNote(b.note);
  const fulfillment = shipping
    ? {
        type: "SHIPMENT",
        state: "PROPOSED",
        shipmentDetails: {
          recipient: {
            displayName: shipping.name,
            emailAddress: b.email,
            phoneNumber: phone,
            address: squareAddress(shipping, shipping.name),
          },
          shippingNote: note || undefined,
        },
      }
    : {
        type: "PICKUP",
        state: "PROPOSED",
        pickupDetails: {
          recipient: { displayName: name, emailAddress: b.email, phoneNumber: phone },
          scheduleType: "ASAP",
          note: note || undefined,
        },
      };

  const soldBefore = await checkStock(b.lines);
  if (soldBefore.length) {
    if (validKey(b.idempotencyKey)) {
      const paid = await alreadyPaid(
        { idempotencyKey: `o-${b.idempotencyKey}`, order: { ...priceableOrder(b), fulfillments: [fulfillment] } },
        b.idempotencyKey,
      );
      if (paid) return paid;
    }
    return soldResponse(soldBefore);
  }

  // Never charge something other than what the customer was shown (prices or tax changed meanwhile).
  // Checked with a calculation first, so a mismatch doesn't leave an unpaid order behind in Square.
  if (Number.isInteger(b.expectedTotal)) {
    const { order: preview } = await square().orders.calculate({ order: priceableOrder(b) });
    const now = Number(preview.totalMoney.amount);
    if (now !== b.expectedTotal)
      return respond(409, { errors: ["The total changed since it was shown. Please check the new total and pay again."], total: now });
  }

  const key = validKey(b.idempotencyKey) ? b.idempotencyKey : randomUUID();
  const orderRequest = { idempotencyKey: `o-${key}`, order: { ...priceableOrder(b), fulfillments: [fulfillment] } };
  const { order } = await square().orders.create(orderRequest);
  const total = Number(order.totalMoney.amount);

  // Authorise only; the card is charged after one last stock check, so a piece that sold a moment
  // ago is never charged for (the authorisation is cancelled instead).
  let auth;
  try {
    ({ payment: auth } = await square().payments.create({
      idempotencyKey: `p-${key}`,
      autocomplete: false,
      sourceId: b.sourceId,
      locationId: SQUARE_LOCATION_ID,
      orderId: order.id,
      amountMoney: order.totalMoney,
      buyerEmailAddress: b.email,
      buyerPhoneNumber: phone,
      billingAddress: squareAddress(billing, name),
      shippingAddress: shipping ? squareAddress(shipping, shipping.name) : undefined,
      // Also on the payment, so the note shows under Transactions as well as on the order.
      note: note ? `Customer note: ${note}`.slice(0, 500) : undefined,
    }));
  } catch (err) {
    await cancelOrder(order.id, key); // declined card etc.: don't leave an unpaid order behind
    throw err;
  }

  // From here on the card is on hold: any failure must release it, never leave it hanging.
  try {
    const soldAfter = await checkStock(b.lines);
    if (soldAfter.length) {
      await releaseHold(auth.id, order.id, key);
      return soldResponse(soldAfter);
    }
    // Note the time before charging: Square's own sale time is then never earlier than ours, so once
    // its count includes this sale it isn't subtracted twice.
    const saleAt = Date.now();
    const { payment } = await square().payments.complete({ paymentId: auth.id });
    recordSale(b.lines, saleAt);
    return respond(200, { orderId: order.id, total, status: payment.status, receiptUrl: payment.receiptUrl });
  } catch (err) {
    // The charge may have gone through even though the call failed (e.g. a timeout on the reply).
    const status = await paymentStatus(auth.id);
    if (status?.status === "COMPLETED") {
      recordSale(b.lines, Date.now());
      return respond(200, { orderId: order.id, total, status: status.status, receiptUrl: status.receiptUrl });
    }
    console.error("CHECKOUT_FAILED after authorising; releasing the hold", order.id, err?.message);
    await releaseHold(auth.id, order.id, key);
    throw err;
  }
}

const validKey = (k) => typeof k === "string" && k.length > 0 && k.length <= 40;

// Best effort: each step logs instead of throwing, so cleanup never hides the original error.
async function cancelOrder(orderId, key) {
  try {
    const { order: current } = await square().orders.get({ orderId });
    if (current.state !== "OPEN") return;
    // Square only cancels an order once each of its fulfillments (the pickup or shipment) is cancelled too.
    await square().orders.update({
      orderId,
      idempotencyKey: `c-${key}`,
      order: {
        locationId: SQUARE_LOCATION_ID,
        version: current.version,
        state: "CANCELED",
        fulfillments: (current.fulfillments ?? []).map((f) => ({ uid: f.uid, state: "CANCELED" })),
      },
    });
  } catch (err) {
    console.error("CLEANUP_FAILED couldn't cancel order", orderId, err?.message);
  }
}
async function releaseHold(paymentId, orderId, key) {
  try {
    await square().payments.cancel({ paymentId });
  } catch (err) {
    console.error("CLEANUP_FAILED couldn't cancel payment", paymentId, err?.message);
  }
  await cancelOrder(orderId, key);
}
async function paymentStatus(paymentId) {
  try {
    return (await square().payments.get({ paymentId })).payment;
  } catch {
    return null;
  }
}

// A repeat of an order that was already paid (same idempotency key, e.g. the page reloaded while
// paying). Re-sending the same order request returns Square's original order if there was one;
// if it creates a new one instead, that one is cancelled straight away.
async function alreadyPaid(orderRequest, key) {
  let order;
  try {
    ({ order } = await square().orders.create(orderRequest));
  } catch {
    return null;
  } // key reused with a different cart
  const paymentId = order.tenders?.[0]?.paymentId ?? order.tenders?.[0]?.id;
  const payment = paymentId ? await paymentStatus(paymentId) : null;
  if (payment?.status === "COMPLETED")
    return respond(200, {
      orderId: order.id,
      total: Number(order.totalMoney.amount),
      status: payment.status,
      receiptUrl: payment.receiptUrl,
      alreadyPaid: true,
    });
  await cancelOrder(order.id, key);
  return null;
}

// Square's decline codes, in words a buyer can act on.
export function declineMessage(code = "") {
  if (/CVV/.test(code)) return "The security code (CVV) doesn't match this card. Please check it and try again.";
  if (/ADDRESS_VERIFICATION|POSTAL_CODE/.test(code)) return "The billing ZIP code doesn't match this card. Please check it and try again.";
  if (/INSUFFICIENT_FUNDS/.test(code)) return "The card was declined for insufficient funds. Please try a different card.";
  if (/EXPIR/.test(code)) return "The card's expiration date doesn't look right, or the card has expired.";
  if (/CARD_NUMBER|INVALID_CARD/.test(code)) return "The card number doesn't look right. Please check it and try again.";
  return "Your card was declined. Please try a different card.";
}
