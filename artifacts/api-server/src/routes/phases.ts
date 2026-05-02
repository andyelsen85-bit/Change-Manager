import { Router, type IRouter, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  planningRecordsTable,
  testRecordsTable,
  pirRecordsTable,
  changeRequestsTable,
  type TestCase,
} from "@workspace/db";
import { requireAuth, getChangeAccess, isPrivilegedAccess } from "../lib/auth";
import { audit } from "../lib/audit";
import { notify, getUserEmail } from "../lib/email";

const router: IRouter = Router();

// Ownership/role gate shared by every phase endpoint. Returns the change row when the
// caller is allowed to read it, otherwise writes 403/404 and returns null.
async function loadChangeForCaller(
  req: Request,
  res: Response,
): Promise<typeof changeRequestsTable.$inferSelect | null> {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return null;
  }
  const [c] = await db.select().from(changeRequestsTable).where(eq(changeRequestsTable.id, id));
  if (!c) {
    res.status(404).json({ error: "Change not found" });
    return null;
  }
  const access = await getChangeAccess(req.session!, c);
  if (!access) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return c;
}

// PLANNING
router.get("/changes/:id/planning", requireAuth, async (req, res): Promise<void> => {
  const c = await loadChangeForCaller(req, res);
  if (!c) return;
  const id = c.id;
  const [row] = await db.select().from(planningRecordsTable).where(eq(planningRecordsTable.changeId, id));
  res.json(
    row ?? {
      changeId: id,
      scope: "",
      implementationPlan: "",
      rollbackPlan: "",
      riskAssessment: "",
      impactedServices: "",
      communicationsPlan: "",
      successCriteria: "",
      signedOff: false,
      signedOffAt: null,
      signedOffBy: null,
      updatedAt: new Date(),
    },
  );
});

router.put("/changes/:id/planning", requireAuth, async (req, res): Promise<void> => {
  const c = await loadChangeForCaller(req, res);
  if (!c) return;
  const id = c.id;
  // Once planning has been signed off it is locked; only an admin or governance
  // role holder (change_manager / eCAB member / CAB chair) can overwrite (e.g.
  // to clear sign-off). Owners / assignees must request a reopen.
  const [existing] = await db.select().from(planningRecordsTable).where(eq(planningRecordsTable.changeId, id));
  if (existing?.signedOff) {
    const access = await getChangeAccess(req.session!, c);
    if (!isPrivilegedAccess(access)) {
      res.status(409).json({ error: "Planning is signed off and locked. Ask a Change Manager to reopen it." });
      return;
    }
  }
  const b = req.body ?? {};
  const values = {
    changeId: id,
    scope: b.scope ?? "",
    implementationPlan: b.implementationPlan ?? "",
    rollbackPlan: b.rollbackPlan ?? "",
    riskAssessment: b.riskAssessment ?? "",
    impactedServices: b.impactedServices ?? "",
    communicationsPlan: b.communicationsPlan ?? "",
    successCriteria: b.successCriteria ?? "",
    signedOff: !!b.signedOff,
    signedOffAt: b.signedOff ? new Date() : null,
    signedOffBy: b.signedOff ? req.session?.username ?? null : null,
  };
  const [row] = await db
    .insert(planningRecordsTable)
    .values(values)
    .onConflictDoUpdate({ target: planningRecordsTable.changeId, set: values })
    .returning();
  await audit(req, {
    action: "planning.updated",
    entityType: "change",
    entityId: id,
    summary: `Planning updated${b.signedOff ? " (signed off)" : ""}`,
    after: row,
  });
  res.json(row);
});

// TESTING
router.get("/changes/:id/testing", requireAuth, async (req, res): Promise<void> => {
  const c = await loadChangeForCaller(req, res);
  if (!c) return;
  const id = c.id;
  const [row] = await db.select().from(testRecordsTable).where(eq(testRecordsTable.changeId, id));
  res.json(
    row ?? {
      changeId: id,
      testPlan: "",
      environment: "",
      overallResult: "pending",
      notes: "",
      testedBy: null,
      testedAt: null,
      cases: [],
      updatedAt: new Date(),
    },
  );
});

router.put("/changes/:id/testing", requireAuth, async (req, res): Promise<void> => {
  const c = await loadChangeForCaller(req, res);
  if (!c) return;
  const id = c.id;
  const b = req.body ?? {};
  const cases: TestCase[] = Array.isArray(b.cases)
    ? b.cases.map((c: TestCase) => ({
        name: String(c.name ?? ""),
        steps: String(c.steps ?? ""),
        expectedResult: String(c.expectedResult ?? ""),
        actualResult: String(c.actualResult ?? ""),
        status: ["pending", "passed", "failed", "blocked"].includes(c.status) ? c.status : "pending",
      }))
    : [];
  const overallResult = b.overallResult ?? "pending";
  const values = {
    changeId: id,
    testPlan: b.testPlan ?? "",
    environment: b.environment ?? "",
    overallResult,
    notes: b.notes ?? "",
    cases,
    testedBy: overallResult !== "pending" ? req.session?.username ?? null : null,
    testedAt: overallResult !== "pending" ? new Date() : null,
  };
  const [row] = await db
    .insert(testRecordsTable)
    .values(values)
    .onConflictDoUpdate({ target: testRecordsTable.changeId, set: values })
    .returning();
  await audit(req, {
    action: "testing.updated",
    entityType: "change",
    entityId: id,
    summary: `Testing updated (overall: ${overallResult})`,
    after: row,
  });
  if (overallResult === "passed" || overallResult === "failed") {
    {
      const owner = await getUserEmail(c.ownerId);
      if (owner) {
        await notify({
          eventKey: "test.signed_off",
          to: [owner],
          subject: `[CHG ${c.ref}] Testing ${overallResult}`,
          text: `Testing for ${c.ref} ${c.title} was ${overallResult}.`,
        });
      }
    }
  }
  res.json(row);
});

// PIR
router.get("/changes/:id/pir", requireAuth, async (req, res): Promise<void> => {
  const c = await loadChangeForCaller(req, res);
  if (!c) return;
  const id = c.id;
  const [row] = await db.select().from(pirRecordsTable).where(eq(pirRecordsTable.changeId, id));
  res.json(
    row ?? {
      changeId: id,
      outcome: "successful",
      objectivesMet: "",
      issuesEncountered: "",
      lessonsLearned: "",
      followupActions: "",
      completedBy: null,
      completedAt: null,
      updatedAt: new Date(),
    },
  );
});

router.put("/changes/:id/pir", requireAuth, async (req, res): Promise<void> => {
  const c = await loadChangeForCaller(req, res);
  if (!c) return;
  const id = c.id;
  const b = req.body ?? {};
  const completed = !!b.completed;
  const values = {
    changeId: id,
    outcome: b.outcome ?? "successful",
    objectivesMet: b.objectivesMet ?? "",
    issuesEncountered: b.issuesEncountered ?? "",
    lessonsLearned: b.lessonsLearned ?? "",
    followupActions: b.followupActions ?? "",
    completedBy: completed ? req.session?.username ?? null : null,
    completedAt: completed ? new Date() : null,
  };
  const [row] = await db
    .insert(pirRecordsTable)
    .values(values)
    .onConflictDoUpdate({ target: pirRecordsTable.changeId, set: values })
    .returning();
  await audit(req, {
    action: "pir.updated",
    entityType: "change",
    entityId: id,
    summary: `PIR updated (outcome: ${values.outcome}${completed ? ", completed" : ""})`,
    after: row,
  });
  res.json(row);
});

export default router;
