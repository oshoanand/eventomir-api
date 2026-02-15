import prisma from "../libs/prisma.js"; // Your prisma client instance

export const createPaidRequest = async (req, res) => {
  try {
    // 1. Destructure data from the request body
    const { customerId, category, serviceDescription, budget, city } = req.body;
    console.log(req.body);

    // 2. Validate required fields
    if (!customerId || !category || !serviceDescription) {
      return res.status(400).json({
        success: false,
        message:
          "Missing required fields: customerId, category, or serviceDescription",
      });
    }

    // 3. Create the request in the database
    // We map camelCase (frontend) to snake_case (database) here
    const newRequest = await prisma.paidRequest.create({
      data: {
        customer_id: customerId,
        category: category,
        service_description: serviceDescription,
        // Handle optional fields: ensure undefined becomes null/undefined for Prisma
        budget: budget || null,
        city: city || null,
        status: "open",
        views: 0,
        responses: 0,
      },
    });

    // 4. Return the created request
    // We map snake_case back to camelCase for the frontend response
    const formattedRequest = {
      id: newRequest.id,
      customerId: newRequest.customer_id,
      category: newRequest.category,
      serviceDescription: newRequest.service_description,
      budget: newRequest.budget,
      city: newRequest.city,
      status: newRequest.status,
      views: newRequest.views,
      responses: newRequest.responses,
      createdAt: newRequest.created_at, // Returns ISO string
    };

    return res.status(201).json({
      success: true,
      message: "Request created successfully",
      request: formattedRequest,
    });
  } catch (error) {
    console.error("Error creating paid request:", error);

    // Check for Prisma specific error codes
    // P2003 = Foreign key constraint failed (e.g., customerId doesn't exist)
    if (error.code === "P2003") {
      return res.status(404).json({
        success: false,
        message:
          "Customer ID not found. Cannot create request for non-existent user.",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Internal server error while creating request.",
    });
  }
};

export const getRequestsByCustomer = async (req, res) => {
  try {
    const { customerId } = req.params;

    if (!customerId) {
      return res.status(400).json({ message: "Customer ID is required" });
    }

    // 1. Fetch from Database
    const requests = await prisma.paidRequest.findMany({
      where: {
        customer_id: customerId,
      },
      orderBy: {
        created_at: "desc", // Sort by newest first
      },
    });

    // 2. Map snake_case DB fields to camelCase Frontend fields
    const formattedRequests = requests.map((req) => ({
      id: req.id,
      customerId: req.customer_id,
      category: req.category,
      serviceDescription: req.service_description, // Mapping here is crucial
      city: req.city,
      budget: req.budget,
      status: req.status,
      views: req.views,
      responses: req.responses,
      createdAt: req.created_at, // Prisma returns Date object, Express serializes to ISO string
    }));

    return res.status(200).json(formattedRequests);
  } catch (error) {
    console.error("Error fetching customer requests:", error);
    return res.status(500).json({ message: "Failed to fetch requests" });
  }
};
