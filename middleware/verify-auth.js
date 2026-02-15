import jwt from "jsonwebtoken";
import "dotenv/config";

function extractToken(req) {
  if (
    req.headers.authorization &&
    req.headers.authorization.split(" ")[0] === "Bearer"
  ) {
    return req.headers.authorization.split(" ")[1];
  } else if (req.query && req.query.token) {
    return req.query.token;
  }
  return null;
}

export const verifyAuth = async (req, res, next) => {
  const token = extractToken(req);

  // console.log(token);
  if (!token) {
    return res.status(401).json({ error: "Unauthorized access " });
  }
  try {
    // 1. Verify the token
    const decoded = jwt.verify(token, process.env.SECRET, {
      algorithms: "HS256",
    });

    // 2. CRITICAL FIX: Attach the user ID to the request object
    // This allows your controllers to access 'req.user.id'
    req.user = { id: decoded.id };

    next();
  } catch (err) {
    console.log(err);
    return res.status(403).json({ access: "Forbidden" });
  }
};
