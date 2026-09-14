import { Router, type IRouter } from "express";
import { getConfigurationStatus } from "../bot/config";
import { getBotStatus, refreshBot } from "../bot";
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

router.post("/bot/refresh", async (_req, res) => {
  const result = await refreshBot();
  res.status(result.commandsEnabled ? 200 : 503).json({
    ...result,
    ...getConfigurationStatus(),
  });
});

export default router;