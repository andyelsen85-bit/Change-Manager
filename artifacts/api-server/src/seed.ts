import { and, eq } from "drizzle-orm";
import {
  db,
  usersTable,
  rolesTable,
  roleAssignmentsTable,
  standardTemplatesTable,
  smtpSettingsTable,
  ssoSettingsTable,
  ldapSettingsTable,
  sslSettingsTable,
  workflowTimeoutsTable,
  changeCategoriesTable,
} from "@workspace/db";
import { inArray } from "drizzle-orm";
import { hashPassword } from "./lib/auth";
import { logger } from "./lib/logger";

// Bootstrap the initial admin user.
//
// We deliberately do NOT seed any default password. On first startup the
// admin row is created with `password_hash = NULL`, which triggers the
// first-run setup wizard in the web UI: the operator visits the app, lands
// on /setup, and chooses the admin password themselves. This avoids the
// security smell of shipping a known default credential.
//
// An operator who wants a fully unattended bootstrap can pre-set the
// password by exporting `INITIAL_ADMIN_PASSWORD` (>= 8 chars). When that
// variable is present we create the admin with that password and skip the
// setup wizard.
type AdminBootstrap =
  | { kind: "env"; password: string }
  | { kind: "setup-required" };

function planAdminBootstrap(): AdminBootstrap {
  const fromEnv = process.env["INITIAL_ADMIN_PASSWORD"];
  if (fromEnv && fromEnv.length >= 8) {
    return { kind: "env", password: fromEnv };
  }
  return { kind: "setup-required" };
}

const ROLES = [
  { key: "change_manager", name: "Change Manager", description: "Owns the change management process end-to-end." },
  { key: "technical_reviewer", name: "Technical Reviewer", description: "Reviews technical risk and feasibility." },
  { key: "business_owner", name: "Business Owner", description: "Approves business impact and timing." },
  { key: "cab_member", name: "CAB Member", description: "Standing member of the Change Advisory Board." },
  { key: "ecab_member", name: "eCAB Member", description: "Emergency CAB member, expedited approval authority." },
  { key: "implementer", name: "Implementer", description: "Carries out the change in production." },
  { key: "tester", name: "Tester", description: "Validates change in pre-prod / prod." },
];

// Roles that were removed from this version and must be cleaned out of any
// pre-existing database. We delete role_assignments first then the roles.
const REMOVED_ROLE_KEYS = ["service_owner", "security_reviewer"] as const;

// Default category catalogue. Admins can add / edit / disable in the
// Settings → Categories panel.
const DEFAULT_CATEGORIES = [
  { key: "network", name: "Network", sortOrder: 10 },
  { key: "hardware", name: "Hardware", sortOrder: 20 },
  { key: "software", name: "Software", sortOrder: 30 },
  { key: "database", name: "Database", sortOrder: 40 },
  { key: "security", name: "Security", sortOrder: 50 },
  { key: "application", name: "Application", sortOrder: 60 },
  { key: "infrastructure", name: "Infrastructure", sortOrder: 70 },
  { key: "other", name: "Other", sortOrder: 999 },
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

  // Remove deprecated roles + their assignments (idempotent — safe on a fresh DB).
  await db
    .delete(roleAssignmentsTable)
    .where(inArray(roleAssignmentsTable.roleKey, REMOVED_ROLE_KEYS as unknown as string[]));
  await db.delete(rolesTable).where(inArray(rolesTable.key, REMOVED_ROLE_KEYS as unknown as string[]));

  // Default change categories — only seeded if the table is empty so an
  // admin's edits aren't reverted on every boot.
  const existingCats = await db.select().from(changeCategoriesTable);
  if (existingCats.length === 0) {
    for (const c of DEFAULT_CATEGORIES) {
      await db.insert(changeCategoriesTable).values(c);
    }
    logger.info({ count: DEFAULT_CATEGORIES.length }, "Seeded change categories");
  }

  // Admin user. On first startup we create the row in either:
  //   (a) "setup required" mode: password_hash=NULL — the operator picks the
  //       password the first time they visit the app via /setup; or
  //   (b) preset mode: password_hash from INITIAL_ADMIN_PASSWORD.
  const plan = planAdminBootstrap();
  const [adminExisting] = await db.select().from(usersTable).where(eq(usersTable.username, "admin"));
  if (!adminExisting) {
    const passwordHash = plan.kind === "env" ? await hashPassword(plan.password) : null;
    await db.insert(usersTable).values({
      username: "admin",
      email: "admin@change-mgmt.local",
      fullName: "System Administrator",
      passwordHash,
      source: "local",
      isAdmin: true,
      isActive: true,
      mustChangePassword: false,
    });
    if (plan.kind === "env") {
      logger.info("Seeded admin user from INITIAL_ADMIN_PASSWORD.");
    } else {
      logger.warn(
        "Seeded admin user without a password. Visit the web app to complete first-time setup at /setup.",
      );
    }
  } else if (plan.kind === "setup-required" && process.env["RESET_ADMIN_PASSWORD"] === "1") {
    // Opt-in recovery path. If an operator is locked out (e.g. a previous
    // version of the seed gave the admin a password they never received),
    // they can set RESET_ADMIN_PASSWORD=1 in the environment and restart
    // the API. On that restart we clear the admin's password_hash so the
    // first-time setup wizard at /setup becomes reachable again. The flag
    // must be removed from the environment after recovery so subsequent
    // restarts don't keep clearing the password — the seed otherwise
    // never touches an existing admin row.
    await db
      .update(usersTable)
      .set({ passwordHash: null, mustChangePassword: false })
      .where(eq(usersTable.id, adminExisting.id));
    logger.warn(
      { adminId: adminExisting.id },
      "RESET_ADMIN_PASSWORD=1 detected: cleared admin password_hash. Visit /setup to claim. REMOVE this env var after recovery.",
    );
  }
  // Suppress unused-import warning when the recovery branch is the only
  // reference to `and` and is conditionally compiled out at runtime.
  void and;
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
  await db.insert(ssoSettingsTable).values({ key: "global" }).onConflictDoNothing();
  await db.insert(workflowTimeoutsTable).values({ key: "global" }).onConflictDoNothing();
}
