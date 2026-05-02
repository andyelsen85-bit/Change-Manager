import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  smtpSettingsTable,
  ldapSettingsTable,
  sslSettingsTable,
  workflowTimeoutsTable,
} from "@workspace/db";
import { requireAdmin } from "../lib/auth";
import { audit } from "../lib/audit";
import { sendTestEmail } from "../lib/email";
import { testLdapConnection } from "../lib/ldap";
import { generateCsr } from "../lib/csr";

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
      fromName: "Change Management",
      enabled: false,
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
    passwordEnc: typeof b.password === "string" && b.password ? b.password : before?.passwordEnc ?? null,
    fromAddress: b.fromAddress ?? "",
    fromName: b.fromName ?? "Change Management",
    enabled: !!b.enabled,
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
    bindPasswordEnc: typeof b.bindPassword === "string" && b.bindPassword ? b.bindPassword : before?.bindPasswordEnc ?? null,
    baseDn: b.baseDn ?? "",
    userFilter: b.userFilter ?? "(uid={{username}})",
    usernameAttr: b.usernameAttr ?? "uid",
    emailAttr: b.emailAttr ?? "mail",
    nameAttr: b.nameAttr ?? "cn",
    tls: !!b.tls,
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
    summary: `LDAP test for ${username}: ${r.success ? "success" : "failed"}`,
    after: { success: r.success, message: r.message },
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

export default router;
