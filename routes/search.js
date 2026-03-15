import express from "express";
import { searchPerformers } from "../controllers/search.js";

const router = express.Router();

router.get("/performers", searchPerformers);

export default router;
