import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import {
  db,
  usersTable,
  rolesTable,
  standardTemplatesTable,
  smtpSettingsTable,
  ldapSettingsTable,
  sslSettingsTable,
  workflowTimeoutsTable,
} from "@workspace/db";
import { hashPassword } from "./lib/auth";
import { logger } from "./lib/logger";

// In production we never seed a known default password. If INITIAL_ADMIN_PASSWORD is
// supplied we use it (and force rotation on first login); otherwise we generate a
// cryptographically random one and log it once at boot. In development we still default
// to "admin" for convenience but flag must_change_password so the user is forced to set
// a real one before doing anything sensitive.
function provisionInitialAdminPassword(): { password: string; mustChange: boolean; source: string } {
  const fromEnv = process.env["INITIAL_ADMIN_PASSWORD"];
  if (fromEnv && fromEnv.length >= 8) {
    return { password: fromEnv, mustChange: true, source: "env:INITIAL_ADMIN_PASSWORD" };
  }
  if ((process.env["NODE_ENV"] ?? "development") === "production") {
    const generated = crypto.randomBytes(18).toString("base64url");
    return { password: generated, mustChange: true, source: "generated" };
  }
  return { password: "admin", mustChange: true, source: "dev-default" };
}

const ROLES = [
  { key: "change_manager", name: "Change Manager", description: "Owns the change management process end-to-end." },
  { key: "technical_reviewer", name: "Technical Reviewer", description: "Reviews technical risk and feasibility." },
  { key: "business_owner", name: "Business Owner", description: "Approves business impact and timing." },
  { key: "ecab_member", name: "eCAB Member", description: "Emergency CAB member, expedited approval authority." },
  { key: "implementer", name: "Implementer", description: "Carries out the change in production." },
  { key: "tester", name: "Tester", description: "Validates change in pre-prod / prod." },
  { key: "service_owner", name: "Service Owner", description: "Owns the impacted service." },
  { key: "security_reviewer", name: "Security Reviewer", description: "Reviews security implications." },
];

const TEMPLATES = [
  {
    name: "Patch — OS minor update (managed fleet)",
    category: "patching",
    description: "Routine OS patch deployment via configuration management.",
    risk: "low", impact: "low", defaultPriority: "low",
    autoApprove: true, bypassCab: true,
    prefilledPlanning: "Apply patch via Ansible playbook 'os-patch-minor.yml' on the staged group, then promote.",
    prefilledTestPlan: "Verify uptime, reboot count, and service status post-patch on a 5% canary before fleet rollout.",
  },
  {
    name: "DNS A/CNAME record change",
    category: "network",
    description: "Add or modify a DNS record in managed zone.",
    risk: "low", impact: "low", defaultPriority: "medium",
    autoApprove: true, bypassCab: true,
    prefilledPlanning: "Update record via IaC commit, run 'terraform apply' against DNS provider.",
    prefilledTestPlan: "dig from two regions, verify TTL countdown and resolution.",
  },
  {
    name: "TLS certificate renewal (auto-managed)",
    category: "security",
    description: "Renew TLS certificate via ACME automation.",
    risk: "low", impact: "low", defaultPriority: "medium",
    autoApprove: true, bypassCab: true,
  },
  {
    name: "Firewall rule — allowlist new SaaS egress",
    category: "network",
    description: "Open egress to a vetted SaaS IP range.",
    risk: "low", impact: "low", defaultPriority: "medium",
    autoApprove: true, bypassCab: true,
  },
  {
    name: "User account onboarding (standard role)",
    category: "identity",
    description: "Provision a new user with the standard role bundle.",
    risk: "low", impact: "low", defaultPriority: "medium",
    autoApprove: true, bypassCab: true,
  },
  {
    name: "User account offboarding",
    category: "identity",
    description: "Disable accounts and revoke tokens for departing employee.",
    risk: "low", impact: "low", defaultPriority: "high",
    autoApprove: true, bypassCab: true,
  },
  {
    name: "Group membership update (standard groups)",
    category: "identity",
    description: "Add or remove user from a pre-approved group.",
    risk: "low", impact: "low", defaultPriority: "low",
    autoApprove: true, bypassCab: true,
  },
  {
    name: "Application restart (managed)",
    category: "operations",
    description: "Restart application service via runbook.",
    risk: "low", impact: "low", defaultPriority: "medium",
    autoApprove: true, bypassCab: true,
  },
  {
    name: "Backup job re-run",
    category: "operations",
    description: "Re-trigger a failed scheduled backup.",
    risk: "low", impact: "low", defaultPriority: "low",
    autoApprove: true, bypassCab: true,
  },
  {
    name: "Disk capacity expansion (cloud volume)",
    category: "infrastructure",
    description: "Expand cloud volume by approved increment.",
    risk: "low", impact: "low", defaultPriority: "medium",
    autoApprove: true, bypassCab: true,
  },
  {
    name: "Container image promote to prod (passed CI)",
    category: "deploy",
    description: "Promote tested container image to production via GitOps.",
    risk: "low", impact: "low", defaultPriority: "medium",
    autoApprove: true, bypassCab: true,
  },
  {
    name: "Feature flag rollout (existing flag)",
    category: "deploy",
    description: "Toggle an existing feature flag to a new percentage.",
    risk: "low", impact: "low", defaultPriority: "low",
    autoApprove: true, bypassCab: true,
  },
  {
    name: "VPN gateway routine restart",
    category: "network",
    description: "Routine restart of VPN gateway during maintenance window.",
    risk: "low", impact: "low", defaultPriority: "low",
    autoApprove: true, bypassCab: true,
  },
  {
    name: "Print queue maintenance",
    category: "operations",
    description: "Clear print queues and restart print services.",
    risk: "low", impact: "low", defaultPriority: "low",
    autoApprove: true, bypassCab: true,
  },
  {
    name: "Mailbox quota adjustment (within policy)",
    category: "identity",
    description: "Adjust mailbox quota within standard policy bounds.",
    risk: "low", impact: "low", defaultPriority: "low",
    autoApprove: true, bypassCab: true,
  },
];

export async function runSeed(): Promise<void> {
  // Roles
  for (const r of ROLES) {
    await db
      .insert(rolesTable)
      .values({ key: r.key, name: r.name, description: r.description, allowsDeputy: true })
      .onConflictDoNothing();
  }

  // Admin user — bootstrap an initial admin only if no admin exists yet. We never
  // overwrite an existing admin's password.
  const [adminExisting] = await db.select().from(usersTable).where(eq(usersTable.username, "admin"));
  if (!adminExisting) {
    const { password, mustChange, source } = provisionInitialAdminPassword();
    const passwordHash = await hashPassword(password);
    await db.insert(usersTable).values({
      username: "admin",
      email: "admin@change-mgmt.local",
      fullName: "System Administrator",
      passwordHash,
      source: "local",
      isAdmin: true,
      isActive: true,
      mustChangePassword: mustChange,
    });
    if (source === "generated") {
      logger.warn(
        { adminPassword: password, source },
        "INITIAL ADMIN PASSWORD (record now — shown only once). Set INITIAL_ADMIN_PASSWORD next time to control this.",
      );
    } else {
      logger.info({ source }, "Seeded admin user; password rotation is required at first login.");
    }
  }

  // Templates
  const existingTemplates = await db.select().from(standardTemplatesTable);
  if (existingTemplates.length === 0) {
    for (const t of TEMPLATES) {
      await db.insert(standardTemplatesTable).values({
        name: t.name,
        description: t.description,
        category: t.category,
        risk: t.risk,
        impact: t.impact,
        defaultPriority: t.defaultPriority,
        autoApprove: t.autoApprove,
        bypassCab: t.bypassCab,
        prefilledPlanning: t.prefilledPlanning ?? null,
        prefilledTestPlan: t.prefilledTestPlan ?? null,
        isActive: true,
      });
    }
    logger.info({ count: TEMPLATES.length }, "Seeded standard change templates");
  }

  // Settings rows (single-row keyed by 'global')
  await db.insert(smtpSettingsTable).values({ key: "global" }).onConflictDoNothing();
  await db.insert(ldapSettingsTable).values({ key: "global" }).onConflictDoNothing();
  await db.insert(sslSettingsTable).values({ key: "global" }).onConflictDoNothing();
  await db.insert(workflowTimeoutsTable).values({ key: "global" }).onConflictDoNothing();
}
