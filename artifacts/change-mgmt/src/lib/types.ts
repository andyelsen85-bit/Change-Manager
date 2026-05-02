export type SessionUser = {
  id: number;
  username: string;
  email: string;
  fullName: string;
  source: "local" | "ldap";
  isAdmin: boolean;
  roles: string[];
};

export type Role = {
  key: string;
  name: string;
  description: string | null;
  allowsDeputy: boolean;
};

export type RoleAssignment = {
  id: number;
  userId: number;
  roleKey: string;
  isDeputy: boolean;
  primaryAssignmentId: number | null;
  userName: string;
  roleName?: string;
};

export type User = {
  id: number;
  username: string;
  email: string;
  fullName: string;
  source: "local" | "ldap";
  isAdmin: boolean;
  isActive: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  roles?: string[];
};

export type StandardTemplate = {
  id: number;
  name: string;
  description: string | null;
  category: string | null;
  risk: "low" | "medium" | "high";
  impact: "low" | "medium" | "high";
  defaultPriority: "low" | "medium" | "high" | "critical";
  autoApprove: boolean;
  bypassCab: boolean;
  prefilledPlanning: string | null;
  prefilledTestPlan: string | null;
  isActive: boolean;
};

export type ChangeTrack = "normal" | "standard" | "emergency";
export type ChangeStatus =
  | "draft"
  | "submitted"
  | "in_review"
  | "awaiting_approval"
  | "approved"
  | "scheduled"
  | "in_progress"
  | "implemented"
  | "in_testing"
  | "awaiting_implementation"
  | "awaiting_pir"
  | "completed"
  | "rejected"
  | "rolled_back"
  | "cancelled";

export type ChangeRequest = {
  id: number;
  ref: string;
  title: string;
  description: string;
  track: ChangeTrack;
  status: ChangeStatus;
  risk: "low" | "medium" | "high";
  impact: "low" | "medium" | "high";
  priority: "low" | "medium" | "high" | "critical";
  ownerId: number;
  ownerName?: string;
  assigneeId: number | null;
  assigneeName?: string | null;
  templateId: number | null;
  cabMeetingId: number | null;
  plannedStart: string | null;
  plannedEnd: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ChangeDetail = ChangeRequest & {
  template?: StandardTemplate | null;
};

export type PlanningRecord = {
  changeId: number;
  scope: string;
  implementationPlan: string;
  rollbackPlan: string;
  riskAssessment: string;
  impactedServices: string;
  communicationsPlan: string;
  successCriteria: string;
  signedOff: boolean;
  signedOffAt: string | null;
  signedOffBy: string | null;
  updatedAt: string;
};

export type TestCase = {
  name: string;
  steps: string;
  expectedResult: string;
  actualResult: string;
  status: "pending" | "passed" | "failed" | "blocked";
};

export type TestRecord = {
  changeId: number;
  testPlan: string;
  environment: string;
  overallResult: "pending" | "passed" | "failed";
  notes: string;
  cases: TestCase[];
  testedBy: string | null;
  testedAt: string | null;
};

export type PirRecord = {
  changeId: number;
  outcome: "successful" | "successful_with_issues" | "failed" | "rolled_back";
  objectivesMet: string;
  issuesEncountered: string;
  lessonsLearned: string;
  followupActions: string;
  completedBy: string | null;
  completedAt: string | null;
};

export type Approval = {
  id: number;
  changeId: number;
  roleKey: string;
  roleName: string;
  approverId: number | null;
  approverName: string | null;
  decision: "pending" | "approved" | "rejected" | "abstain";
  comment: string | null;
  decidedAt: string | null;
  viaDeputy: boolean;
};

export type Comment = {
  id: number;
  changeId: number;
  authorId: number;
  authorName: string;
  body: string;
  createdAt: string;
};

export type CabMember = {
  id: number;
  meetingId: number;
  userId: number;
  roleKey: string | null;
  isDeputy: boolean;
  userName: string;
  userEmail: string;
};

export type CabMeeting = {
  id: number;
  title: string;
  kind: "cab" | "ecab";
  scheduledStart: string;
  scheduledEnd: string;
  location: string;
  status: "scheduled" | "in_progress" | "completed" | "cancelled";
};

export type CabMeetingDetail = CabMeeting & {
  agenda: string;
  minutes: string;
  chairUserId: number | null;
  chairName: string | null;
  members: CabMember[];
  changes: { id: number; ref: string; title: string; track: ChangeTrack; status: ChangeStatus; risk: string }[];
};

export type DashboardSummary = {
  totalChanges: number;
  openChanges: number;
  awaitingApproval: number;
  scheduledThisWeek: number;
  emergencyOpen: number;
  successRate: number;
  byStatus: { key: string; count: number }[];
  byTrack: { key: string; count: number }[];
  byRisk: { key: string; count: number }[];
};

export type ActivityItem = {
  id: number;
  timestamp: string;
  actorName: string;
  action: string;
  entityType: string;
  entityId: number | null;
  summary: string;
};

export type DashboardTask = {
  kind: "approval" | "testing" | "pir";
  changeId: number;
  ref: string;
  title: string;
  note?: string;
};

export type AuditEntry = {
  id: number;
  timestamp: string;
  actorId: number | null;
  actorName: string;
  action: string;
  entityType: string;
  entityId: number | null;
  summary: string;
  ipAddress: string | null;
  userAgent: string | null;
  before: unknown;
  after: unknown;
};

export type NotificationPreference = {
  eventKey: string;
  email: boolean;
  inApp: boolean;
};

export type SmtpSettings = {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  passwordSet: boolean;
  fromAddress: string;
  fromName: string;
  enabled: boolean;
};

export type LdapSettings = {
  enabled: boolean;
  url: string;
  bindDn: string;
  bindPasswordSet: boolean;
  baseDn: string;
  userFilter: string;
  usernameAttr: string;
  emailAttr: string;
  nameAttr: string;
  tls: boolean;
};

export type SslSettings = {
  certificateInstalled: boolean;
  privateKeyInstalled: boolean;
  chainInstalled: boolean;
  forceHttps: boolean;
  hstsEnabled: boolean;
};

export type WorkflowTimeouts = {
  approvalReminderHours: number;
  approvalEscalationHours: number;
  cabReminderHours: number;
  pirDueDays: number;
  emergencyApprovalMinutes: number;
};

export const NOTIFICATION_EVENTS: { key: string; label: string; group: string }[] = [
  { key: "change.created", label: "Change created", group: "Lifecycle" },
  { key: "change.submitted", label: "Change submitted", group: "Lifecycle" },
  { key: "change.status_changed", label: "Change status changed", group: "Lifecycle" },
  { key: "change.scheduled", label: "Change scheduled", group: "Lifecycle" },
  { key: "change.completed", label: "Change completed", group: "Lifecycle" },
  { key: "approval.requested", label: "Approval requested", group: "Approvals" },
  { key: "approval.granted", label: "Approval granted", group: "Approvals" },
  { key: "approval.rejected", label: "Approval rejected", group: "Approvals" },
  { key: "cab.invited", label: "CAB invitation", group: "CAB" },
  { key: "cab.reminder", label: "CAB reminder", group: "CAB" },
  { key: "cab.minutes_published", label: "CAB minutes published", group: "CAB" },
  { key: "test.signed_off", label: "Test results signed off", group: "Testing & PIR" },
  { key: "pir.due", label: "PIR due", group: "Testing & PIR" },
  { key: "comment.added", label: "Comment added", group: "Collaboration" },
  { key: "assignment.changed", label: "Assignment changed", group: "Collaboration" },
];

export const TRACK_OPTIONS: { value: ChangeTrack; label: string; description: string }[] = [
  { value: "normal", label: "Normal", description: "Full review with planning, approvals, CAB, testing, and PIR." },
  { value: "standard", label: "Standard", description: "Pre-approved, low-risk template. Auto-approves and bypasses CAB." },
  { value: "emergency", label: "Emergency", description: "Expedited path with eCAB approvals." },
];

export const STATUS_LABELS: Record<ChangeStatus, string> = {
  draft: "Draft",
  submitted: "Submitted",
  in_review: "In Review",
  awaiting_approval: "Awaiting Approval",
  approved: "Approved",
  scheduled: "Scheduled",
  in_progress: "In Progress",
  implemented: "Implemented",
  in_testing: "In Testing",
  awaiting_implementation: "Awaiting Implementation",
  awaiting_pir: "Awaiting PIR",
  completed: "Completed",
  rejected: "Rejected",
  rolled_back: "Rolled Back",
  cancelled: "Cancelled",
};
