import { Router, type IRouter } from "express";
import { getConfigurationStatus } from "../bot/config";
import { getBotStatus } from "../bot";

const router: IRouter = Router();

router.get("/bot/status", (_req, res) => {
  res.json({
    ...getBotStatus(),
    ...getConfigurationStatus(),
  });
});

export default router;