// import crypto from "crypto";
// import "dotenv/config";

// const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:8080";
// const TINKOFF_TERMINAL_KEY = process.env.TINKOFF_TERMINAL_KEY;
// const TINKOFF_PASSWORD = process.env.TINKOFF_PASSWORD;
// const TINKOFF_API_URL = "https://securepay.tinkoff.ru/v2";
// // const TINKOFF_API_URL = "https://rest-api-test.tinkoff.ru/v2";
// const APP_URL = process.env.WEB_APP_URL || "http://localhost:3000";

// /**
//  * Generates the SHA-256 token required by Tinkoff
//  */
// export const generateTinkoffToken = (data) => {
//   // 1. Filter out specific fields according to Tinkoff docs
//   const keys = Object.keys(data).filter(
//     (k) => !["Token", "Receipt", "DATA"].includes(k),
//   );

//   // 2. Add Password to the list of keys
//   const dataWithPassword = { ...data, Password: TINKOFF_PASSWORD };
//   keys.push("Password");

//   // 3. Sort alphabetically
//   keys.sort();

//   // 4. Concatenate values
//   let concatenatedValues = "";
//   for (const key of keys) {
//     // Tinkoff expects string values for the hash
//     if (dataWithPassword[key] !== undefined && dataWithPassword[key] !== null) {
//       concatenatedValues += String(dataWithPassword[key]);
//     }
//   }

//   // 5. Hash with SHA-256
//   return crypto.createHash("sha256").update(concatenatedValues).digest("hex");
// };

// /**
//  * Initializes a payment session with Tinkoff
//  */
// export const initTinkoffEventTicketPayment = async (
//   order,
//   event,
//   userEmail,
// ) => {
//   const payload = {
//     TerminalKey: TINKOFF_TERMINAL_KEY,
//     Amount: Math.round(order.totalPrice * 100),
//     OrderId: order.id,
//     Description: `Билеты на: ${event.title}`,
//     NotificationURL: `${API_BASE_URL}/api/webhooks/tinkoff-event-ticket`,
//     SuccessURL: `${APP_URL}/tickets?payment=success`,
//     FailURL: `${APP_URL}/events/${event.id}?payment=failed`,
//     DATA: {
//       Email: userEmail,
//     },
//   };

//   payload.Token = generateTinkoffToken(payload);

//   const response = await fetch(`${TINKOFF_API_URL}/Init`, {
//     method: "POST",
//     headers: { "Content-Type": "application/json" },
//     body: JSON.stringify(payload),
//   });

//   const result = await response.json();

//   if (!result.Success) {
//     throw new Error(result.Message || "Failed to initialize Tinkoff payment");
//   }

//   return {
//     paymentUrl: result.PaymentURL,
//     paymentId: result.PaymentId,
//   };
// };

// /**
//  * Initializes a payment session with Tinkoff specifically for Paid Requests
//  */
// export const initTinkoffRequestPayment = async (
//   paymentId,
//   amount,
//   category,
//   userEmail,
// ) => {
//   const payload = {
//     TerminalKey: TINKOFF_TERMINAL_KEY,
//     Amount: Math.round(amount * 100), // Tinkoff expects kopecks (cents)
//     OrderId: paymentId, // We use your DB Payment ID as the OrderId
//     Description: `Оплата публикации заявки: ${category}`,
//     NotificationURL: `${process.env.API_BASE_URL}/api/webhooks/tinkoff`,
//     SuccessURL: `${APP_URL}/customer-profile?payment=success`,
//     FailURL: `${APP_URL}/create-request?payment=failed`,
//     DATA: {
//       Email: userEmail,
//     },
//   };

//   payload.Token = generateTinkoffToken(payload);

//   const response = await fetch(`${TINKOFF_API_URL}/Init`, {
//     method: "POST",
//     headers: { "Content-Type": "application/json" },
//     body: JSON.stringify(payload),
//   });

//   const result = await response.json();

//   if (!result.Success) {
//     throw new Error(result.Message || "Failed to initialize Tinkoff payment");
//   }

//   return {
//     paymentUrl: result.PaymentURL,
//     paymentId: result.PaymentId,
//   };
// };

// /**
//  * Initializes a payment session with Tinkoff specifically for Wallet Top-Ups
//  */
// export const initTinkoffTopUpPayment = async (
//   paymentId,
//   amount,
//   userEmail,
//   userType,
// ) => {
//   const payload = {
//     TerminalKey: TINKOFF_TERMINAL_KEY,
//     Amount: Math.round(amount * 100),
//     OrderId: paymentId,
//     Description: `Пополнение кошелька на ${amount} руб.`,
//     NotificationURL: `${API_BASE_URL}/api/webhooks/tinkoff`,
//     SuccessURL:
//       userType === "customer"
//         ? `${APP_URL}/customer-profile?topup=success`
//         : `${APP_URL}/performer-profile?topup=success`,
//     FailURL:
//       userType === "customer"
//         ? `${APP_URL}/customer-profile?topup=failed`
//         : `${APP_URL}/performer-profile?topup=failed`,
//     DATA: {
//       Email: userEmail,
//     },
//   };

//   payload.Token = generateTinkoffToken(payload);
//   const response = await fetch(`${TINKOFF_API_URL}/Init`, {
//     method: "POST",
//     headers: { "Content-Type": "application/json" },
//     body: JSON.stringify(payload),
//   });

//   const result = await response.json();

//   if (!result.Success) {
//     throw new Error(
//       result.Message || "Failed to initialize Tinkoff top-up payment",
//     );
//   }

//   return {
//     paymentUrl: result.PaymentURL,
//     paymentId: result.PaymentId,
//   };
// };

// /**
//  * Initializes a payment session with Tinkoff specifically for Subscriptions
//  */
// export const initTinkoffSubscriptionPayment = async (
//   paymentId,
//   amount,
//   planName,
//   interval,
//   userEmail,
// ) => {
//   const intervalNames = { month: "1 мес.", half_year: "6 мес.", year: "1 год" };
//   const periodLabel = intervalNames[interval] || "период";

//   const payload = {
//     TerminalKey: TINKOFF_TERMINAL_KEY,
//     Amount: Math.round(amount * 100),
//     OrderId: paymentId,
//     Description: `Подписка на тариф «${planName}» (${periodLabel})`,
//     NotificationURL: `${API_BASE_URL}/api/webhooks/tinkoff`,
//     SuccessURL: `${APP_URL}/pricing?subscription=success`,
//     FailURL: `${APP_URL}/pricing?subscription=failed`,
//     DATA: {
//       Email: userEmail,
//     },
//   };

//   payload.Token = generateTinkoffToken(payload);
//   const response = await fetch(`${TINKOFF_API_URL}/Init`, {
//     method: "POST",
//     headers: { "Content-Type": "application/json" },
//     body: JSON.stringify(payload),
//   });

//   const result = await response.json();

//   if (!result.Success) {
//     throw new Error(
//       result.Message || "Failed to initialize Tinkoff subscription payment",
//     );
//   }

//   return {
//     paymentUrl: result.PaymentURL,
//     paymentId: result.PaymentId,
//   };
// };

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
  // DATA, Receipt, and Token are excluded. Tinkoff only hashes flat values.
  // Also strip null/undefined values to prevent hashing literal "undefined"
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
  const payload = {
    TerminalKey: TINKOFF_TERMINAL_KEY,
    Amount: Math.round(order.totalPrice * 100),
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
          Name: `Билет: ${event.title.substring(0, 64)}`, // Tinkoff Item Name max length is 64 chars
          Price: Math.round(event.price * 100),
          Quantity: order.ticketCount,
          Amount: Math.round(order.totalPrice * 100),
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
          PaymentMethod: "advance", // Use 'advance' or 'payment' for top-ups
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
