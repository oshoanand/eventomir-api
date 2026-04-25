import crypto from "crypto";
import "dotenv/config";

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:8800";
const TINKOFF_TERMINAL_KEY = process.env.TINKOFF_TERMINAL_KEY;
const TINKOFF_PASSWORD = process.env.TINKOFF_PASSWORD;
const TINKOFF_API_URL = "https://securepay.tinkoff.ru/v2";
const APP_URL = process.env.WEB_APP_URL || "http://localhost:3000";

/**
 * Robust SHA-256 token generator for Tinkoff.
 * Strictly follows the sorting and filtering rules.
 */
export const generateTinkoffToken = (data) => {
  const params = { ...data, Password: TINKOFF_PASSWORD };

  // 1. Filter out fields that SHOULD NOT be part of the signature
  const keys = Object.keys(params).filter(
    (key) =>
      !["Token", "Receipt", "DATA"].includes(key) &&
      params[key] !== undefined &&
      params[key] !== null,
  );

  // 2. Sort keys alphabetically
  keys.sort();

  // 3. Concatenate values of those keys as strings
  const concatenatedValues = keys
    .map((key) => {
      // Booleans must be explicitly stringified for Tinkoff
      if (typeof params[key] === "boolean") {
        return params[key] ? "true" : "false";
      }
      return String(params[key]);
    })
    .join("");

  // 4. SHA-256 Hash
  return crypto.createHash("sha256").update(concatenatedValues).digest("hex");
};

/**
 * Internal helper to send requests to Tinkoff API
 */
async function callTinkoff(endpoint, payload) {
  // Generate token right before sending to ensure all fields are included
  payload.Token = generateTinkoffToken(payload);

  try {
    const response = await fetch(`${TINKOFF_API_URL}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const result = await response.json();

    if (!result.Success) {
      console.error(`Tinkoff ${endpoint} Error:`, result);
      throw new Error(result.Details || result.Message || "Tinkoff API Error");
    }

    return result;
  } catch (error) {
    console.error(`Tinkoff Connection Error (${endpoint}):`, error.message);
    throw error;
  }
}

/**
 * Initializes a payment session for Event Tickets
 * Includes mandatory Receipt object for FZ-54 compliance.
 */
export const initTinkoffEventTicketPayment = async (
  order,
  event,
  userEmail,
) => {
  // 🚨 FIX: Safe unit price calculation (prevents fractional kopeck errors)
  const unitPriceInKopecks = Math.round(
    (order.totalPrice / order.ticketCount) * 100,
  );
  const totalAmountInKopecks = Math.round(order.totalPrice * 100);

  const payload = {
    TerminalKey: TINKOFF_TERMINAL_KEY,
    Amount: totalAmountInKopecks,
    OrderId: order.id,
    Description: `Билеты на: ${event.title}`,
    NotificationURL: `${API_BASE_URL}/api/webhooks/tinkoff-event-ticket`,
    SuccessURL: `${APP_URL}/tickets?payment=success`,
    FailURL: `${APP_URL}/events/${event.id}?payment=failed`,
    DATA: { Email: userEmail },
    Receipt: {
      Email: userEmail,
      Taxation: "usn_income",
      Items: [
        {
          Name: `Билет: ${event.title.substring(0, 64)}`,
          Price: unitPriceInKopecks,
          Quantity: order.ticketCount,
          Amount: totalAmountInKopecks,
          PaymentMethod: "full_prepayment",
          PaymentObject: "service",
          Tax: "none",
        },
      ],
    },
  };

  const result = await callTinkoff("/Init", payload);
  return { paymentUrl: result.PaymentURL, paymentId: result.PaymentId };
};

/**
 * Initializes payment for Request Postings
 */
export const initTinkoffRequestPayment = async (
  paymentId,
  amount,
  category,
  userEmail,
) => {
  const payload = {
    TerminalKey: TINKOFF_TERMINAL_KEY,
    Amount: Math.round(amount * 100),
    OrderId: paymentId,
    Description: `Оплата публикации заявки: ${category}`,
    NotificationURL: `${API_BASE_URL}/api/webhooks/tinkoff`,
    SuccessURL: `${APP_URL}/customer-profile?payment=success`,
    FailURL: `${APP_URL}/create-request?payment=failed`,
    DATA: { Email: userEmail },
    Receipt: {
      Email: userEmail,
      Taxation: "usn_income",
      Items: [
        {
          Name: `Публикация заявки: ${category.substring(0, 45)}`,
          Price: Math.round(amount * 100),
          Quantity: 1,
          Amount: Math.round(amount * 100),
          PaymentMethod: "full_prepayment",
          PaymentObject: "service",
          Tax: "none",
        },
      ],
    },
  };

  const result = await callTinkoff("/Init", payload);
  return { paymentUrl: result.PaymentURL, paymentId: result.PaymentId };
};

/**
 * Wallet Top-Up logic
 */
export const initTinkoffTopUpPayment = async (
  paymentId,
  amount,
  userEmail,
  userType,
) => {
  const payload = {
    TerminalKey: TINKOFF_TERMINAL_KEY,
    Amount: Math.round(amount * 100),
    OrderId: paymentId,
    Description: `Пополнение кошелька`,
    NotificationURL: `${API_BASE_URL}/api/webhooks/tinkoff`,
    SuccessURL: `${APP_URL}/${userType}-profile?topup=success`,
    FailURL: `${APP_URL}/${userType}-profile?topup=failed`,
    DATA: { Email: userEmail },
    Receipt: {
      Email: userEmail,
      Taxation: "usn_income",
      Items: [
        {
          Name: "Пополнение баланса",
          Price: Math.round(amount * 100),
          Quantity: 1,
          Amount: Math.round(amount * 100),
          PaymentMethod: "advance",
          PaymentObject: "payment",
          Tax: "none",
        },
      ],
    },
  };

  const result = await callTinkoff("/Init", payload);
  return { paymentUrl: result.PaymentURL, paymentId: result.PaymentId };
};

/**
 * Subscription payment logic
 */
export const initTinkoffSubscriptionPayment = async (
  paymentId,
  amount,
  planName,
  interval,
  userEmail,
) => {
  const intervalNames = { month: "1 мес.", half_year: "6 мес.", year: "1 год" };
  const periodLabel = intervalNames[interval] || "период";

  const payload = {
    TerminalKey: TINKOFF_TERMINAL_KEY,
    Amount: Math.round(amount * 100),
    OrderId: paymentId,
    Description: `Подписка «${planName}» (${periodLabel})`,
    NotificationURL: `${API_BASE_URL}/api/webhooks/tinkoff`,
    SuccessURL: `${APP_URL}/pricing?subscription=success`,
    FailURL: `${APP_URL}/pricing?subscription=failed`,
    DATA: { Email: userEmail },
    Receipt: {
      Email: userEmail,
      Taxation: "usn_income",
      Items: [
        {
          Name: `Тариф: ${planName.substring(0, 50)}`,
          Price: Math.round(amount * 100),
          Quantity: 1,
          Amount: Math.round(amount * 100),
          PaymentMethod: "full_prepayment",
          PaymentObject: "service",
          Tax: "none",
        },
      ],
    },
  };

  const result = await callTinkoff("/Init", payload);
  return { paymentUrl: result.PaymentURL, paymentId: result.PaymentId };
};

/**
 * NEW: Initializes a B2B payment session with Tinkoff.
 * Used for corporate clients paying via Tinkoff's B2B invoicing link.
 */
export const initTinkoffB2BPayment = async (
  order,
  company,
  plan,
  userEmail,
) => {
  const amountInKopecks = Math.round(order.amount * 100);

  const payload = {
    TerminalKey: TINKOFF_TERMINAL_KEY,
    Amount: amountInKopecks,
    OrderId: order.id,
    Description: `Оплата B2B подписки: ${plan.name} по счету-договору`,
    NotificationURL: `${API_BASE_URL}/api/webhooks/tinkoff`,
    SuccessURL: `${APP_URL}/pricing?b2b_payment=success`,
    FailURL: `${APP_URL}/pricing?b2b_payment=failed`,
    DATA: { Email: userEmail },
    Receipt: {
      Email: userEmail,
      Taxation: "usn_income",
      Items: [
        {
          Name: `Подписка на тариф ${plan.name.substring(0, 40)}`,
          Price: amountInKopecks,
          Quantity: 1,
          Amount: amountInKopecks,
          PaymentMethod: "full_prepayment",
          PaymentObject: "service",
          Tax: "none",
          SupplierInfo: {
            Name: company.company_name || company.name || "ООО Клиент",
            Inn: company.inn,
          },
        },
      ],
    },
  };

  const result = await callTinkoff("/Init", payload);

  return {
    paymentUrl: result.PaymentURL,
    paymentId: result.PaymentId,
  };
};

// =====================================================================
// 🚨 NEW: ESCROW (TWO-STEP) PAYMENT LOGIC
// =====================================================================

/**
 * Step 1: Initialize Two-Step Payment (HOLD FUNDS)
 */
export const initTinkoffEscrowPayment = async (
  paymentId,
  amount,
  bookingId,
  userEmail,
) => {
  const amountInKopecks = Math.round(amount * 100);
  const payload = {
    TerminalKey: TINKOFF_TERMINAL_KEY,
    Amount: amountInKopecks,
    OrderId: paymentId,
    PayType: "O", // 🚨 CRITICAL: "O" means Two-Step Payment (Auth & Capture)
    Description: `Безопасная сделка. Холдирование средств по брони #${bookingId.substring(0, 8)}`,
    NotificationURL: `${API_BASE_URL}/api/webhooks/tinkoff`,
    SuccessURL: `${APP_URL}/my-bookings?payment=success`,
    FailURL: `${APP_URL}/my-bookings?payment=failed`,
    DATA: { Email: userEmail },
    Receipt: {
      Email: userEmail,
      Taxation: "usn_income",
      Items: [
        {
          Name: `Оплата выступления (Резерв)`,
          Price: amountInKopecks,
          Quantity: 1,
          Amount: amountInKopecks,
          PaymentMethod: "prepayment",
          PaymentObject: "service",
          Tax: "none",
        },
      ],
    },
  };

  const result = await callTinkoff("/Init", payload);
  return { paymentUrl: result.PaymentURL, paymentId: result.PaymentId };
};

/**
 * Step 2: Capture Funds (RELEASE FUNDS TO PERFORMER)
 * Calls Tinkoff API to finalize the charge.
 */
export const confirmTinkoffPayment = async (paymentId, amount) => {
  const payload = {
    TerminalKey: TINKOFF_TERMINAL_KEY,
    PaymentId: String(paymentId),
    Amount: Math.round(amount * 100),
  };
  return await callTinkoff("/Confirm", payload);
};

/**
 * Cancel/Refund (RELEASE FUNDS BACK TO CUSTOMER)
 * Unfreezes the hold if event is rejected/disputed.
 */
export const cancelTinkoffPayment = async (paymentId) => {
  const payload = {
    TerminalKey: TINKOFF_TERMINAL_KEY,
    PaymentId: String(paymentId),
  };
  return await callTinkoff("/Cancel", payload);
};
