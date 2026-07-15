import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import {
  db,
  smtpSettingsTable,
  ldapSettingsTable,
  sslSettingsTable,
  workflowTimeoutsTable,
  sdpSettingsTable,
} from "@workspace/db";
import { testSdpConnection } from "../lib/sdp";
import { requireAdmin } from "../lib/auth";
import { audit } from "../lib/audit";
import { sendTestEmail } from "../lib/email";
import { testLdapConnection } from "../lib/ldap";
import { generateCsr } from "../lib/csr";
import { encryptSecret } from "../lib/secret-crypto";
import {
  flushNotificationQueue,
  getNotificationSettings,
  getQueueDepth,
  setNotificationSettings,
} from "../lib/notification-worker";

const router: IRouter = Router();

const KEY = "global";

function maskSmtp(row: typeof smtpSettingsTable.$inferSelect | undefined) {
  if (!row) {
    return {
      host: "",
      port: 587,
      secure: false,
      username: "",
      passwordSet: false,
      fromAddress: "",
      fromName: "Change-it",
      enabled: false,
      tlsRejectUnauthorized: true,
      caCertInstalled: false,
    };
  }
  return {
    host: row.host,
    port: row.port,
    secure: row.secure,
    username: row.username,
    passwordSet: !!row.passwordEnc,
    fromAddress: row.fromAddress,
    fromName: row.fromName,
    enabled: row.enabled,
    tlsRejectUnauthorized: row.tlsRejectUnauthorized,
    caCertInstalled: !!row.caCertPem,
  };
}

router.get("/settings/smtp", requireAdmin, async (_req, res): Promise<void> => {
  const [row] = await db.select().from(smtpSettingsTable).where(eq(smtpSettingsTable.key, KEY));
  res.json(maskSmtp(row));
});

router.put("/settings/smtp", requireAdmin, async (req, res): Promise<void> => {
  const b = req.body ?? {};
  const [before] = await db.select().from(smtpSettingsTable).where(eq(smtpSettingsTable.key, KEY));
  const values = {
    key: KEY,
    host: b.host ?? "",
    port: typeof b.port === "number" ? b.port : 587,
    secure: !!b.secure,
    username: b.username ?? "",
    passwordEnc:
      typeof b.password === "string" && b.password
        ? encryptSecret(b.password)
        : before?.passwordEnc ?? null,
    fromAddress: b.fromAddress ?? "",
    fromName: b.fromName ?? "Change-it",
    enabled: !!b.enabled,
    tlsRejectUnauthorized: b.tlsRejectUnauthorized === false ? false : true,
    caCertPem:
      typeof b.caCertPem === "string" && b.caCertPem.trim()
        ? b.caCertPem
        : b.caCertPem === null
          ? null
          : before?.caCertPem ?? null,
  };
  const [row] = await db
    .insert(smtpSettingsTable)
    .values(values)
    .onConflictDoUpdate({ target: smtpSettingsTable.key, set: values })
    .returning();
  await audit(req, {
    action: "settings.smtp_updated",
    entityType: "settings",
    entityId: null,
    summary: `Updated SMTP settings (host=${row.host}, enabled=${row.enabled})`,
    before: maskSmtp(before),
    after: maskSmtp(row),
  });
  res.json(maskSmtp(row));
});

router.post("/settings/smtp/test", requireAdmin, async (req, res): Promise<void> => {
  const to = (req.body ?? {}).to;
  if (typeof to !== "string" || !to.includes("@")) {
    res.status(400).json({ error: "Valid recipient email required" });
    return;
  }
  const r = await sendTestEmail(to);
  await audit(req, {
    action: "settings.smtp_tested",
    entityType: "settings",
    entityId: null,
    summary: `SMTP test → ${to}: ${r.success ? "success" : "failed"}`,
    after: r,
  });
  res.json(r);
});

function maskLdap(row: typeof ldapSettingsTable.$inferSelect | undefined) {
  if (!row) {
    return {
      enabled: false,
      url: "",
      bindDn: "",
      bindPasswordSet: false,
      baseDn: "",
      userFilter: "(uid={{username}})",
      usernameAttr: "uid",
      emailAttr: "mail",
      nameAttr: "cn",
      tls: false,
      tlsRejectUnauthorized: true,
      caCertInstalled: false,
      issuerCertInstalled: false,
    };
  }
  return {
    enabled: row.enabled,
    url: row.url,
    bindDn: row.bindDn,
    bindPasswordSet: !!row.bindPasswordEnc,
    baseDn: row.baseDn,
    userFilter: row.userFilter,
    usernameAttr: row.usernameAttr,
    emailAttr: row.emailAttr,
    nameAttr: row.nameAttr,
    tls: row.tls,
    tlsRejectUnauthorized: row.tlsRejectUnauthorized,
    caCertInstalled: !!row.caCertPem,
    issuerCertInstalled: !!row.issuerCertPem,
  };
}

router.get("/settings/ldap", requireAdmin, async (_req, res): Promise<void> => {
  const [row] = await db.select().from(ldapSettingsTable).where(eq(ldapSettingsTable.key, KEY));
  res.json(maskLdap(row));
});

router.put("/settings/ldap", requireAdmin, async (req, res): Promise<void> => {
  const b = req.body ?? {};
  const [before] = await db.select().from(ldapSettingsTable).where(eq(ldapSettingsTable.key, KEY));
  const values = {
    key: KEY,
    enabled: !!b.enabled,
    url: b.url ?? "",
    bindDn: b.bindDn ?? "",
    bindPasswordEnc:
      typeof b.bindPassword === "string" && b.bindPassword
        ? encryptSecret(b.bindPassword)
        : before?.bindPasswordEnc ?? null,
    baseDn: b.baseDn ?? "",
    userFilter: b.userFilter ?? "(uid={{username}})",
    usernameAttr: b.usernameAttr ?? "uid",
    emailAttr: b.emailAttr ?? "mail",
    nameAttr: b.nameAttr ?? "cn",
    tls: !!b.tls,
    // Default to TRUE (verify) when the admin hasn't explicitly opted out,
    // even if the body omitted the field — preserves the secure default.
    tlsRejectUnauthorized: b.tlsRejectUnauthorized === false ? false : true,
    caCertPem:
      typeof b.caCertPem === "string" && b.caCertPem.trim()
        ? b.caCertPem
        : b.caCertPem === null
          ? null
          : before?.caCertPem ?? null,
    issuerCertPem:
      typeof b.issuerCertPem === "string" && b.issuerCertPem.trim()
        ? b.issuerCertPem
        : b.issuerCertPem === null
          ? null
          : before?.issuerCertPem ?? null,
  };
  const [row] = await db
    .insert(ldapSettingsTable)
    .values(values)
    .onConflictDoUpdate({ target: ldapSettingsTable.key, set: values })
    .returning();
  await audit(req, {
    action: "settings.ldap_updated",
    entityType: "settings",
    entityId: null,
    summary: `Updated LDAP settings (url=${row.url}, enabled=${row.enabled})`,
    before: maskLdap(before),
    after: maskLdap(row),
  });
  res.json(maskLdap(row));
});

router.post("/settings/ldap/test", requireAdmin, async (req, res): Promise<void> => {
  const { username, password } = req.body ?? {};
  if (typeof username !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "username and password required" });
    return;
  }
  const r = await testLdapConnection(username, password);
  await audit(req, {
    action: "settings.ldap_tested",
    entityType: "settings",
    entityId: null,
    summary: `LDAP test for ${username}: ${r.success ? "success" : `failed at ${r.stage}`}`,
    // Persist the full diagnostic so admins can review historical test
    // attempts from the audit log without re-running the bind.
    after: {
      success: r.success,
      stage: r.stage,
      message: r.message,
      code: r.code,
      details: r.details,
      userDn: r.userDn,
    },
  });
  res.json(r);
});

function maskSsl(row: typeof sslSettingsTable.$inferSelect | undefined) {
  return {
    certificateInstalled: !!row?.certificatePem,
    privateKeyInstalled: !!row?.privateKeyPem,
    chainInstalled: !!row?.chainPem,
    forceHttps: !!row?.forceHttps,
    hstsEnabled: !!row?.hstsEnabled,
  };
}

router.get("/settings/ssl", requireAdmin, async (_req, res): Promise<void> => {
  const [row] = await db.select().from(sslSettingsTable).where(eq(sslSettingsTable.key, KEY));
  res.json(maskSsl(row));
});

router.put("/settings/ssl", requireAdmin, async (req, res): Promise<void> => {
  const b = req.body ?? {};
  const [before] = await db.select().from(sslSettingsTable).where(eq(sslSettingsTable.key, KEY));
  const values = {
    key: KEY,
    certificatePem: typeof b.certificatePem === "string" && b.certificatePem ? b.certificatePem : before?.certificatePem ?? null,
    privateKeyPem: typeof b.privateKeyPem === "string" && b.privateKeyPem ? b.privateKeyPem : before?.privateKeyPem ?? null,
    chainPem: typeof b.chainPem === "string" && b.chainPem ? b.chainPem : before?.chainPem ?? null,
    forceHttps: !!b.forceHttps,
    hstsEnabled: !!b.hstsEnabled,
  };
  const [row] = await db
    .insert(sslSettingsTable)
    .values(values)
    .onConflictDoUpdate({ target: sslSettingsTable.key, set: values })
    .returning();
  await audit(req, {
    action: "settings.ssl_updated",
    entityType: "settings",
    entityId: null,
    summary: `Updated SSL settings (forceHttps=${row.forceHttps}, hsts=${row.hstsEnabled})`,
    before: maskSsl(before),
    after: maskSsl(row),
  });
  res.json(maskSsl(row));
});

router.post("/settings/ssl/csr", requireAdmin, async (req, res): Promise<void> => {
  const b = req.body ?? {};
  if (typeof b.commonName !== "string" || !b.commonName.trim()) {
    res.status(400).json({ error: "commonName is required" });
    return;
  }
  let result;
  try {
    result = generateCsr({
      commonName: b.commonName,
      organization: typeof b.organization === "string" ? b.organization : undefined,
      organizationalUnit: typeof b.organizationalUnit === "string" ? b.organizationalUnit : undefined,
      locality: typeof b.locality === "string" ? b.locality : undefined,
      state: typeof b.state === "string" ? b.state : undefined,
      country: typeof b.country === "string" ? b.country : undefined,
      emailAddress: typeof b.emailAddress === "string" ? b.emailAddress : undefined,
      subjectAltNames: Array.isArray(b.subjectAltNames)
        ? b.subjectAltNames.filter((s: unknown): s is string => typeof s === "string")
        : [],
      keyBits: b.keyBits === 3072 || b.keyBits === 4096 ? b.keyBits : 2048,
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Invalid CSR input" });
    return;
  }
  // Persist the freshly-generated private key on the SSL settings row so that
  // when the admin uploads the signed certificate later it pairs correctly.
  const [before] = await db.select().from(sslSettingsTable).where(eq(sslSettingsTable.key, KEY));
  const values = {
    key: KEY,
    certificatePem: before?.certificatePem ?? null,
    privateKeyPem: result.privateKeyPem,
    chainPem: before?.chainPem ?? null,
    forceHttps: before?.forceHttps ?? false,
    hstsEnabled: before?.hstsEnabled ?? false,
  };
  await db
    .insert(sslSettingsTable)
    .values(values)
    .onConflictDoUpdate({ target: sslSettingsTable.key, set: values });
  await audit(req, {
    action: "settings.ssl_csr_generated",
    entityType: "settings",
    entityId: null,
    summary: `Generated CSR (CN=${result.subject.commonName}, ${result.keyBits}-bit, SANs=${result.subjectAltNames.length})`,
    after: {
      subject: result.subject,
      subjectAltNames: result.subjectAltNames,
      keyBits: result.keyBits,
      publicKeyFingerprintSha256: result.publicKeyFingerprintSha256,
    },
  });
  // Return the CSR + metadata. The private key is intentionally NOT returned —
  // it is held server-side and paired with the cert that comes back from the PKI.
  res.json({
    csrPem: result.csrPem,
    publicKeyFingerprintSha256: result.publicKeyFingerprintSha256,
    subject: result.subject,
    subjectAltNames: result.subjectAltNames,
    keyBits: result.keyBits,
  });
});

router.get("/settings/workflow-timeouts", requireAdmin, async (_req, res): Promise<void> => {
  const [row] = await db.select().from(workflowTimeoutsTable).where(eq(workflowTimeoutsTable.key, KEY));
  res.json(
    row ?? {
      approvalReminderHours: 24,
      approvalEscalationHours: 48,
      cabReminderHours: 24,
      pirDueDays: 7,
      emergencyApprovalMinutes: 60,
    },
  );
});

router.put("/settings/workflow-timeouts", requireAdmin, async (req, res): Promise<void> => {
  const b = req.body ?? {};
  const [before] = await db.select().from(workflowTimeoutsTable).where(eq(workflowTimeoutsTable.key, KEY));
  const values = {
    key: KEY,
    approvalReminderHours: typeof b.approvalReminderHours === "number" ? b.approvalReminderHours : 24,
    approvalEscalationHours: typeof b.approvalEscalationHours === "number" ? b.approvalEscalationHours : 48,
    cabReminderHours: typeof b.cabReminderHours === "number" ? b.cabReminderHours : 24,
    pirDueDays: typeof b.pirDueDays === "number" ? b.pirDueDays : 7,
    emergencyApprovalMinutes: typeof b.emergencyApprovalMinutes === "number" ? b.emergencyApprovalMinutes : 60,
  };
  const [row] = await db
    .insert(workflowTimeoutsTable)
    .values(values)
    .onConflictDoUpdate({ target: workflowTimeoutsTable.key, set: values })
    .returning();
  await audit(req, {
    action: "settings.workflow_timeouts_updated",
    entityType: "settings",
    entityId: null,
    summary: "Updated workflow timeouts",
    before,
    after: row,
  });
  res.json(row);
});

// Notification batching: lets admins choose the digest interval and see
// how many items are pending plus when the next send will run. The worker
// itself lives in lib/notification-worker.ts.
async function notificationStatus(): Promise<{
  batchIntervalMinutes: number;
  lastRunAt: string | null;
  nextRunAt: string;
  queuedCount: number;
}> {
  const { batchIntervalMinutes, lastRunAt } = await getNotificationSettings();
  const queuedCount = await getQueueDepth();
  const baseMs = lastRunAt ? lastRunAt.getTime() : Date.now();
  const nextMs = baseMs + batchIntervalMinutes * 60_000;
  return {
    batchIntervalMinutes,
    lastRunAt: lastRunAt ? lastRunAt.toISOString() : null,
    nextRunAt: new Date(Math.max(nextMs, Date.now())).toISOString(),
    queuedCount,
  };
}

router.get("/settings/notifications", requireAdmin, async (_req, res): Promise<void> => {
  res.json(await notificationStatus());
});

router.put("/settings/notifications", requireAdmin, async (req, res): Promise<void> => {
  const b = req.body ?? {};
  const raw = Number(b.batchIntervalMinutes);
  if (!Number.isFinite(raw) || raw < 1 || raw > 60 * 24) {
    res.status(400).json({ error: "batchIntervalMinutes must be between 1 and 1440" });
    return;
  }
  const before = await getNotificationSettings();
  await setNotificationSettings(raw);
  const after = await notificationStatus();
  await audit(req, {
    action: "settings.notifications_updated",
    entityType: "settings",
    entityId: null,
    summary: `Notification batch interval ${before.batchIntervalMinutes} → ${after.batchIntervalMinutes} min`,
    before,
    after,
  });
  res.json(after);
});

router.post("/settings/notifications/flush", requireAdmin, async (req, res): Promise<void> => {
  const r = await flushNotificationQueue();
  await audit(req, {
    action: "settings.notifications_flushed",
    entityType: "settings",
    entityId: null,
    summary: `Manual digest flush — ${r.usersNotified} user(s), ${r.itemsSent} item(s)`,
    after: r,
  });
  res.json({ ...r, status: await notificationStatus() });
});

// ─── ServiceDesk Plus (on-premises) integration ─────────────────────────────

function maskSdp(row: typeof sdpSettingsTable.$inferSelect | undefined) {
  if (!row) {
    return {
      enabled: false,
      baseUrl: "",
      technicianKeySet: false,
      webhookSecret: "",
      tlsRejectUnauthorized: true,
      lastWebhookAt: null as string | null,
      lastWebhookRequestId: null as string | null,
      lastWebhookStatus: null as string | null,
    };
  }
  return {
    enabled: row.enabled,
    baseUrl: row.baseUrl,
    technicianKeySet: !!row.technicianKeyEnc,
    // The webhook secret is intentionally readable by admins — they must
    // paste it into the SD+ custom trigger configuration.
    webhookSecret: row.webhookSecret,
    tlsRejectUnauthorized: row.tlsRejectUnauthorized,
    lastWebhookAt: row.lastWebhookAt ? row.lastWebhookAt.toISOString() : null,
    lastWebhookRequestId: row.lastWebhookRequestId,
    lastWebhookStatus: row.lastWebhookStatus,
  };
}

router.get("/settings/sdp", requireAdmin, async (_req, res): Promise<void> => {
  const [row] = await db.select().from(sdpSettingsTable).where(eq(sdpSettingsTable.key, KEY));
  res.json(maskSdp(row));
});

router.put("/settings/sdp", requireAdmin, async (req, res): Promise<void> => {
  const b = req.body ?? {};
  const [before] = await db.select().from(sdpSettingsTable).where(eq(sdpSettingsTable.key, KEY));
  const values = {
    key: KEY,
    enabled: !!b.enabled,
    baseUrl: typeof b.baseUrl === "string" ? b.baseUrl.trim().replace(/\/+$/, "") : "",
    technicianKeyEnc:
      typeof b.technicianKey === "string" && b.technicianKey
        ? encryptSecret(b.technicianKey)
        : before?.technicianKeyEnc ?? null,
    // Generate a webhook secret on first save so the admin never runs with
    // an empty (insecure) secret.
    webhookSecret: before?.webhookSecret || randomBytes(24).toString("base64url"),
    tlsRejectUnauthorized: b.tlsRejectUnauthorized === false ? false : true,
  };
  const [row] = await db
    .insert(sdpSettingsTable)
    .values(values)
    .onConflictDoUpdate({ target: sdpSettingsTable.key, set: values })
    .returning();
  await audit(req, {
    action: "settings.sdp_updated",
    entityType: "settings",
    entityId: null,
    summary: `Updated ServiceDesk Plus settings (baseUrl=${row.baseUrl}, enabled=${row.enabled})`,
    before: before ? { ...maskSdp(before), webhookSecret: "(hidden)" } : null,
    after: { ...maskSdp(row), webhookSecret: "(hidden)" },
  });
  res.json(maskSdp(row));
});

// Rotate the shared webhook secret. The old secret stops working immediately;
// the admin must update the SD+ custom trigger with the new value.
router.post("/settings/sdp/rotate-secret", requireAdmin, async (req, res): Promise<void> => {
  const [before] = await db.select().from(sdpSettingsTable).where(eq(sdpSettingsTable.key, KEY));
  const secret = randomBytes(24).toString("base64url");
  const values = {
    key: KEY,
    webhookSecret: secret,
  };
  const [row] = await db
    .insert(sdpSettingsTable)
    .values(values)
    .onConflictDoUpdate({ target: sdpSettingsTable.key, set: { webhookSecret: secret } })
    .returning();
  await audit(req, {
    action: "settings.sdp_secret_rotated",
    entityType: "settings",
    entityId: null,
    summary: "ServiceDesk Plus webhook secret rotated",
    before: { hadSecret: !!before?.webhookSecret },
  });
  res.json(maskSdp(row));
});

// Outbound connectivity test: calls the SD+ REST API with the stored
// technician key and reports success/failure without touching any ticket.
router.post("/settings/sdp/test", requireAdmin, async (req, res): Promise<void> => {
  const r = await testSdpConnection();
  await audit(req, {
    action: "settings.sdp_tested",
    entityType: "settings",
    entityId: null,
    summary: `ServiceDesk Plus connection test: ${r.success ? "success" : "failed"} — ${r.message}`,
    after: r,
  });
  res.json(r);
});

export default router;
