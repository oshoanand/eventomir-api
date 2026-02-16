import prisma from "../libs/prisma.js";

import prisma from "../libs/prisma.js";
import { createPaymentIntent } from "../services/payment-gateway.js";

// --- Create Request (Initiate Payment) ---
export const createPaidRequest = async (req, res) => {
  try {
    const { customerId, category, serviceDescription, budget, city } = req.body;

    // 1. Validation
    if (!customerId || !category || !serviceDescription) {
      return res.status(400).json({ message: "Missing required fields." });
    }

    // 2. Get Fixed Price (In a real app, fetch from DB/Config)
    const REQUEST_PRICE = 490; // 490 RUB

    // 3. Create Payment Record (PENDING)
    const payment = await prisma.payment.create({
      data: {
        userId: customerId,
        amount: REQUEST_PRICE,
        status: "PENDING",
        provider: "mock-provider",
        // Metadata helps the webhook know what this payment is for
        metadata: {
          type: "PAID_REQUEST",
        },
      },
    });

    // 4. Create Paid Request Record (PENDING_PAYMENT)
    // It is NOT visible to performers yet.
    const newRequest = await prisma.paidRequest.create({
      data: {
        customerId,
        category,
        serviceDescription,
        budget,
        city,
        status: "PENDING_PAYMENT",
        paymentId: payment.id,
      },
    });

    // 5. Generate Payment Link
    // Pass requestId in metadata so webhook can find and activate it
    const paymentIntent = await createPaymentIntent(REQUEST_PRICE, "RUB", {
      paymentId: payment.id,
      requestId: newRequest.id,
      type: "PAID_REQUEST",
    });

    // 6. Update Payment with Provider Transaction ID
    await prisma.payment.update({
      where: { id: payment.id },
      data: { providerTxId: paymentIntent.id },
    });

    // 7. Return Checkout URL to Frontend
    res.json({
      success: true,
      checkoutUrl: paymentIntent.checkoutUrl,
    });
  } catch (error) {
    console.error("Create Request Error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

// --- Get Customer Requests ---
export const getCustomerRequests = async (req, res) => {
  try {
    const { customerId } = req.params;

    const requests = await prisma.paidRequest.findMany({
      where: {
        customerId,
        // Only return requests that are active or closed (paid)
        status: { in: ["OPEN", "CLOSED"] },
      },
      orderBy: { createdAt: "desc" },
    });

    res.json(requests);
  } catch (error) {
    console.error("Get Customer Requests Error:", error);
    res.status(500).json({ message: "Failed to fetch requests" });
  }
};

// --- Performer Feed (Public/Protected) ---
export const getRequestsFeed = async (req, res) => {
  try {
    const { roles, city } = req.query;

    // Convert comma-separated roles to array
    const roleList = roles ? roles.split(",") : [];

    const whereClause = {
      status: "OPEN", // Only show active, paid requests
    };

    // Filter by Category (if roles provided)
    if (roleList.length > 0) {
      whereClause.category = { in: roleList };
    }

    // Filter by City (Optional: Include requests with NO city (Online) + Matching City)
    if (city) {
      whereClause.OR = [
        { city: { equals: city, mode: "insensitive" } },
        { city: null }, // Remote/Online requests
      ];
    }

    const requests = await prisma.paidRequest.findMany({
      where: whereClause,
      orderBy: { createdAt: "desc" },
      take: 50, // Limit feed size
    });

    res.json(requests);
  } catch (error) {
    console.error("Feed Error:", error);
    res.status(500).json({ message: "Failed to fetch feed" });
  }
};

// export const createPaidRequest = async (req, res) => {
//   try {
//     // 1. Destructure data from the request body
//     const { customerId, category, serviceDescription, budget, city } = req.body;
//     console.log(req.body);

//     // 2. Validate required fields
//     if (!customerId || !category || !serviceDescription) {
//       return res.status(400).json({
//         success: false,
//         message:
//           "Missing required fields: customerId, category, or serviceDescription",
//       });
//     }

//     // 3. Create the request in the database
//     // We map camelCase (frontend) to snake_case (database) here
//     const newRequest = await prisma.paidRequest.create({
//       data: {
//         customer_id: customerId,
//         category: category,
//         service_description: serviceDescription,
//         // Handle optional fields: ensure undefined becomes null/undefined for Prisma
//         budget: budget || null,
//         city: city || null,
//         status: "open",
//         views: 0,
//         responses: 0,
//       },
//     });

//     // 4. Return the created request
//     // We map snake_case back to camelCase for the frontend response
//     const formattedRequest = {
//       id: newRequest.id,
//       customerId: newRequest.customer_id,
//       category: newRequest.category,
//       serviceDescription: newRequest.service_description,
//       budget: newRequest.budget,
//       city: newRequest.city,
//       status: newRequest.status,
//       views: newRequest.views,
//       responses: newRequest.responses,
//       createdAt: newRequest.created_at, // Returns ISO string
//     };

//     return res.status(201).json({
//       success: true,
//       message: "Request created successfully",
//       request: formattedRequest,
//     });
//   } catch (error) {
//     console.error("Error creating paid request:", error);

//     // Check for Prisma specific error codes
//     // P2003 = Foreign key constraint failed (e.g., customerId doesn't exist)
//     if (error.code === "P2003") {
//       return res.status(404).json({
//         success: false,
//         message:
//           "Customer ID not found. Cannot create request for non-existent user.",
//       });
//     }

//     return res.status(500).json({
//       success: false,
//       message: "Internal server error while creating request.",
//     });
//   }
// };

// export const getRequestsByCustomer = async (req, res) => {
//   try {
//     const { customerId } = req.params;

//     if (!customerId) {
//       return res.status(400).json({ message: "Customer ID is required" });
//     }

//     // 1. Fetch from Database
//     const requests = await prisma.paidRequest.findMany({
//       where: {
//         customer_id: customerId,
//       },
//       orderBy: {
//         created_at: "desc", // Sort by newest first
//       },
//     });

//     // 2. Map snake_case DB fields to camelCase Frontend fields
//     const formattedRequests = requests.map((req) => ({
//       id: req.id,
//       customerId: req.customer_id,
//       category: req.category,
//       serviceDescription: req.service_description, // Mapping here is crucial
//       city: req.city,
//       budget: req.budget,
//       status: req.status,
//       views: req.views,
//       responses: req.responses,
//       createdAt: req.created_at, // Prisma returns Date object, Express serializes to ISO string
//     }));

//     return res.status(200).json(formattedRequests);
//   } catch (error) {
//     console.error("Error fetching customer requests:", error);
//     return res.status(500).json({ message: "Failed to fetch requests" });
//   }
// };
