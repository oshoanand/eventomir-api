import { v4 as uuidv4 } from "uuid";

/**
 * Creates a mock payment intent.
 */
export const createPaymentIntent = async (
  amount,
  currency = "RUB",
  metadata = {},
) => {
  const transactionId = uuidv4();

  // This URL points to YOUR BACKEND server to handle the success callback
  // Adjust process.env.API_URL to your Node.js server address (e.g., http://localhost:8800)
  const backendUrl = process.env.API_BASE_URL || "http://localhost:8800";

  // The Mock Gateway "redirects" the user here after payment
  const mockSuccessUrl = `${backendUrl}/api/payments/mock-success?txId=${transactionId}`;

  return {
    id: transactionId,
    amount,
    currency,
    checkoutUrl: mockSuccessUrl,
  };
};
