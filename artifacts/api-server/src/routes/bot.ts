import { Router, type IRouter } from "express";
import { getPublicBotStatus } from "../bot";

const router: IRouter = Router();

router.get("/bot/status/public", async (_req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await getPublicBotStatus());
  } catch (error) {
    next(error);
  }
});

router.get("/bot/status", (_req, res) => {
  res.status(403).json({
    error:
      "Detailed diagnostics are available through the Discord administrator status command.",
  });
});

// There is no HTTP authentication layer in this service. Do not expose a
// bot-wide mutation endpoint that could bypass current Discord Administrator
// checks. Operational refreshes are intentionally handled through Discord.
router.post("/bot/refresh", (_req, res) => {
  res.status(403).json({
    error: "Bot refresh is disabled on the unauthenticated API; automatic recovery remains enabled.",
  });
});

export default router;