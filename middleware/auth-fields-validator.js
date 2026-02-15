import { body, validationResult } from "express-validator";

export const loginValidationRules = [
  // Mobile number validation
  body("mobile")
    .trim()
    .isNumeric()
    .withMessage("Mobile number must contain only digits")
    .isLength({ min: 10, max: 10 })
    .withMessage("Mobile number must be exactly 10 digits"),

  // password rule
  body("password")
    .trim()
    .isLength({ min: 8 })
    .withMessage("Password must be at least 8 characters long"),
];

export const registerValidationRules = [
  body("name").trim().notEmpty().withMessage("Username is required"),
  body("email").trim().notEmpty().withMessage("email is required"),
  // Mobile number validation
  body("mobile")
    .trim()
    .isNumeric()
    .withMessage("Mobile number must contain only digits")
    .isLength({ min: 10, max: 10 })
    .withMessage("Mobile number must be exactly 10 digits"),

  // password rule minimum 8
  body("password")
    .trim()
    .isLength({ min: 8 })
    .withMessage("Password must be at least 8 characters long"),
];

// 2. Create the generic error-handling middleware
export const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) {
    return next(); // Everything is fine, move to the controller
  }

  // If there are errors, stop the request and return them
  return res.status(400).json({
    success: false,
    errors: errors.array().map((err) => ({
      field: err.path,
      message: err.msg,
    })),
  });
};
