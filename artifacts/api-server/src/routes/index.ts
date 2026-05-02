import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import usersRouter from "./users";
import rolesRouter from "./roles";
import templatesRouter from "./templates";
import changesRouter from "./changes";
import phasesRouter from "./phases";
import approvalsRouter from "./approvals";
import cabRouter from "./cab";
import commentsRouter from "./comments";
import dashboardRouter from "./dashboard";
import settingsRouter from "./settings";
import auditRouter from "./audit";
import backupRouter from "./backup";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(usersRouter);
router.use(rolesRouter);
router.use(templatesRouter);
router.use(changesRouter);
router.use(phasesRouter);
router.use(approvalsRouter);
router.use(cabRouter);
router.use(commentsRouter);
router.use(dashboardRouter);
router.use(settingsRouter);
router.use(auditRouter);
router.use(backupRouter);

export default router;
