import crypto from "crypto";
import "dotenv/config";

const TINKOFF_TERMINAL_KEY = process.env.TINKOFF_TERMINAL_KEY;
const TINKOFF_PASSWORD = process.env.TINKOFF_PASSWORD;
// const TINKOFF_API_URL = "https://securepay.tinkoff.ru/v2";
const TINKOFF_API_URL = "https://rest-api-test.tinkoff.ru/v2";
const APP_URL = process.env.WEB_APP_URL || "http://localhost:3000";

/**
 * Generates the SHA-256 token required by Tinkoff
 */
export const generateTinkoffToken = (data) => {
  // 1. Filter out specific fields according to Tinkoff docs
  const keys = Object.keys(data).filter(
    (k) => !["Token", "Receipt", "DATA"].includes(k),
  );

  // 2. Add Password to the list of keys
  const dataWithPassword = { ...data, Password: TINKOFF_PASSWORD };
  keys.push("Password");

  // 3. Sort alphabetically
  keys.sort();

  // 4. Concatenate values
  let concatenatedValues = "";
  for (const key of keys) {
    // Tinkoff expects string values for the hash
    if (dataWithPassword[key] !== undefined && dataWithPassword[key] !== null) {
      concatenatedValues += String(dataWithPassword[key]);
    }
  }

  // 5. Hash with SHA-256
  return crypto.createHash("sha256").update(concatenatedValues).digest("hex");
};

/**
 * Initializes a payment session with Tinkoff
 */
export const initTinkoffPayment = async (order, event, userEmail) => {
  const payload = {
    TerminalKey: TINKOFF_TERMINAL_KEY,
    Amount: Math.round(order.totalPrice * 100), // Tinkoff expects amount in kopecks (cents)
    OrderId: order.id,
    Description: `Билеты на: ${event.title}`,
    NotificationURL: `${process.env.API_URL}/api/payments/tinkoff-webhook`,
    SuccessURL: `${APP_URL}/tickets?payment=success`,
    FailURL: `${APP_URL}/events/${event.id}?payment=failed`,
    DATA: {
      Email: userEmail,
    },
  };

  payload.Token = generateTinkoffToken(payload);

  const response = await fetch(`${TINKOFF_API_URL}/Init`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const result = await response.json();

  if (!result.Success) {
    throw new Error(result.Message || "Failed to initialize Tinkoff payment");
  }

  return {
    paymentUrl: result.PaymentURL,
    paymentId: result.PaymentId,
  };
};
