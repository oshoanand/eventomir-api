const generateCustomOrderId = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");

  // Format: YYYYMMDDHHmmss
  const timestamp = `${year}${month}${day}${hours}${minutes}${seconds}`;

  // Generate 4 random digits (0000 to 9999)
  const randomDigits = String(Math.floor(Math.random() * 10000)).padStart(
    4,
    "0",
  );

  // Result example: EVENT-20260304143756-8492
  return `EVENT-${timestamp}-${randomDigits}`;
};

export { generateCustomOrderId };
