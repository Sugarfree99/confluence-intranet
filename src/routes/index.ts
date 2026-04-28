import express from "express";
import { pageRoutes } from "./pages";
import { adminRoutes } from "./admin";
import { aiRoutes } from "./ai";
import { qaRoutes } from "./qa";

const router = express.Router();

router.use("/pages", pageRoutes);
router.use("/admin", adminRoutes);
router.use("/ai", aiRoutes);
router.use("/qa", qaRoutes);

// Health check
router.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

export default router;
