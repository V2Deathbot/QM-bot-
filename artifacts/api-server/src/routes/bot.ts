import { Router, type IRouter } from "express";
import { getConfigurationStatus } from "../bot/config";
import { getBotStatus } from "../bot";
import { checkTrelloReadiness } from "../bot/trello";

const router: IRouter = Router();

router.get("/bot/status", async (_req, res) => {
  const trello = await checkTrelloReadiness();
  res.json({
    ...getBotStatus(),
    ...getConfigurationStatus(),
    trello,
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