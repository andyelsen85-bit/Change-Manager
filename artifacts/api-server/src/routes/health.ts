import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

const handler = (_req: unknown, res: { json: (data: unknown) => void }) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
};

router.get("/health", handler);
router.get("/healthz", handler);

export default router;
