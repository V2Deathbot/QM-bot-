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

export default router;