import crypto from "crypto";
import "dotenv/config";

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:8080";
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

/**
 * Initializes a payment session with Tinkoff specifically for Paid Requests
 */
export const initTinkoffRequestPayment = async (
  paymentId,
  amount,
  category,
  userEmail,
) => {
  const payload = {
    TerminalKey: TINKOFF_TERMINAL_KEY,
    Amount: Math.round(amount * 100), // Tinkoff expects kopecks (cents)
    OrderId: paymentId, // We use your DB Payment ID as the OrderId
    Description: `Оплата публикации заявки: ${category}`,
    NotificationURL: `${process.env.API_BASE_URL}/api/webhooks/tinkoff`,
    SuccessURL: `${APP_URL}/customer-profile?payment=success`,
    FailURL: `${APP_URL}/create-request?payment=failed`,
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

/**
 * Initializes a payment session with Tinkoff specifically for Wallet Top-Ups
 */
export const initTinkoffTopUpPayment = async (paymentId, amount, userEmail) => {
  const payload = {
    TerminalKey: TINKOFF_TERMINAL_KEY,
    Amount: Math.round(amount * 100),
    OrderId: paymentId,
    Description: `Пополнение кошелька на ${amount} руб.`,
    NotificationURL: `${API_BASE_URL}/api/webhooks/tinkoff`,
    SuccessURL: `${APP_URL}/customer-profile?topup=success`,
    FailURL: `${APP_URL}/customer-profile?topup=failed`,
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
    throw new Error(
      result.Message || "Failed to initialize Tinkoff top-up payment",
    );
  }

  return {
    paymentUrl: result.PaymentURL,
    paymentId: result.PaymentId,
  };
};
