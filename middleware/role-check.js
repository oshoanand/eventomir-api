// middleware/role-check.js

/**
 * Middleware to restrict access based on user roles.
 * @param {string[]} allowedRoles - Array of roles allowed to access the route.
 */
export const requireRole = (allowedRoles) => {
  return (req, res, next) => {
    // req.user is populated by your verifyAuth middleware (JWT verification)
    if (!req.user) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    // console.log(req.user.role);

    if (!allowedRoles.includes(req.user.role)) {
      return res
        .status(403)
        .json({ message: "Forbidden: Insufficient permissions" });
    }

    next();
  };
};
