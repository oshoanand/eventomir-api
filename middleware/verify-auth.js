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

  if (!token) {
    return res.status(401).json({ error: "Unauthorized access " });
  }
  try {
    // 1. Verify the token
    const decoded = jwt.verify(token, process.env.SECRET, {
      algorithms: "HS256",
    });

    // console.log(decoded.role);
    // 2. CRITICAL FIX: Attach the user ID to the request object
    // This allows your controllers to access 'req.user.id'
    req.user = { id: decoded.id, role: decoded.role, email: decoded.email };

    next();
  } catch (err) {
    console.log(err);
    return res.status(403).json({ access: "Forbidden" });
  }
};

export const verifyOptionalAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;

  // Если токена нет, просто продолжаем выполнение как гость
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    req.user = null;
    return next();
  }

  const token = authHeader.split(" ")[1];

  try {
    // Пытаемся расшифровать токен
    const decoded = jwt.verify(token, process.env.SECRET);
    req.user = decoded; // Если токен валиден, прикрепляем пользователя
  } catch (error) {
    // Если токен истек или подделан, мы НЕ выбрасываем ошибку.
    // Мы просто обнуляем пользователя и продолжаем как гость.
    req.user = null;
  }

  // Обязательно вызываем next() вне зависимости от результата
  next();
};
