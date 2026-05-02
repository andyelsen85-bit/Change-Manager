// ITIL v4-aligned change request state machines.
// Each track has its own allowed transition graph. Terminal statuses cancelled / rolled_back
// are reachable from any non-terminal status. Standard changes auto-progress through approval/CAB
// stages and skip awaiting_approval entirely.

export type ChangeTrack = "normal" | "standard" | "emergency";

export type ChangeStatus =
  | "draft"
  | "submitted"
  | "in_review"
  | "awaiting_approval"
  | "approved"
  | "rejected"
  | "scheduled"
  | "awaiting_implementation"
  | "in_progress"
  | "implemented"
  | "in_testing"
  | "awaiting_pir"
  | "completed"
  | "cancelled"
  | "rolled_back";

const TERMINAL_FROM_ANY: ChangeStatus[] = ["cancelled", "rolled_back"];

const NORMAL: Record<ChangeStatus, ChangeStatus[]> = {
  draft: ["submitted", "cancelled"],
  submitted: ["in_review", "cancelled"],
  in_review: ["awaiting_approval", "rejected", "cancelled"],
  awaiting_approval: ["approved", "rejected", "cancelled"],
  approved: ["scheduled", "cancelled"],
  scheduled: ["in_progress", "cancelled"],
  in_progress: ["implemented", "rolled_back"],
  implemented: ["in_testing", "rolled_back"],
  in_testing: ["awaiting_pir", "rolled_back"],
  awaiting_pir: ["completed", "rolled_back"],
  completed: [],
  rejected: [],
  cancelled: [],
  rolled_back: [],
  awaiting_implementation: [],
};

// Standard changes auto-approve and bypass CAB; flow is short.
const STANDARD: Record<ChangeStatus, ChangeStatus[]> = {
  draft: ["scheduled", "awaiting_implementation", "cancelled"],
  awaiting_implementation: ["scheduled", "in_progress", "cancelled"],
  scheduled: ["in_progress", "cancelled"],
  in_progress: ["implemented", "rolled_back"],
  implemented: ["completed", "rolled_back"],
  completed: [],
  cancelled: [],
  rolled_back: [],
  // Unused for standard track but needed to satisfy type:
  submitted: [],
  in_review: [],
  awaiting_approval: [],
  approved: [],
  rejected: [],
  in_testing: [],
  awaiting_pir: [],
};

// Emergency: collapsed flow but eCAB approval is mandatory before implementation.
// Approval may be granted out-of-band (phone/IM) and then recorded in the system,
// but the system enforces approved -> in_progress: no draft -> in_progress shortcut.
const EMERGENCY: Record<ChangeStatus, ChangeStatus[]> = {
  draft: ["awaiting_approval", "cancelled"],
  awaiting_approval: ["approved", "rejected", "cancelled"],
  approved: ["in_progress", "cancelled"],
  in_progress: ["implemented", "rolled_back"],
  implemented: ["awaiting_pir", "rolled_back"],
  awaiting_pir: ["completed", "rolled_back"],
  completed: [],
  rejected: [],
  cancelled: [],
  rolled_back: [],
  // Unused for emergency:
  submitted: [],
  in_review: [],
  scheduled: [],
  awaiting_implementation: [],
  in_testing: [],
};

const TRANSITIONS_BY_TRACK: Record<ChangeTrack, Record<ChangeStatus, ChangeStatus[]>> = {
  normal: NORMAL,
  standard: STANDARD,
  emergency: EMERGENCY,
};

// ---------------------------------------------------------------------------
// REVERSE TRANSITIONS — controlled "walk-back" graphs.
//
// The forward graph is strict: a Normal change can only progress draft → …
// → completed. In real ITIL operations changes are sometimes pushed forward
// prematurely (the reviewer hits "Send for approval" before the Change
// Manager is ready, or a CAB needs to rework an already-approved change).
// We expose a separate "revert" action restricted to Change Manager / Admin
// that walks the change BACK to a sensible earlier status. The maps below
// list, for each current status, which prior statuses are valid revert
// targets. `rolled_back` is intentionally empty: a physically rolled-back
// change cannot be un-rolled back.
// ---------------------------------------------------------------------------

const REVERSE_NORMAL: Record<ChangeStatus, ChangeStatus[]> = {
  draft: [],
  submitted: ["draft"],
  in_review: ["submitted", "draft"],
  awaiting_approval: ["in_review", "submitted", "draft"],
  approved: ["awaiting_approval", "in_review", "draft"],
  scheduled: ["approved", "awaiting_approval"],
  in_progress: ["scheduled", "approved"],
  implemented: ["in_progress"],
  in_testing: ["implemented", "in_progress"],
  awaiting_pir: ["in_testing", "implemented"],
  completed: ["awaiting_pir"], // reopen after closure
  cancelled: ["draft"], // reopen a cancelled change
  rejected: ["draft", "in_review"], // reopen a rejected change
  rolled_back: [], // truly terminal
  awaiting_implementation: [],
};

const REVERSE_STANDARD: Record<ChangeStatus, ChangeStatus[]> = {
  draft: [],
  awaiting_implementation: ["draft"],
  scheduled: ["awaiting_implementation", "draft"],
  in_progress: ["scheduled", "awaiting_implementation"],
  implemented: ["in_progress"],
  completed: ["implemented"],
  cancelled: ["draft"],
  rolled_back: [],
  // unused for standard
  submitted: [],
  in_review: [],
  awaiting_approval: [],
  approved: [],
  rejected: [],
  in_testing: [],
  awaiting_pir: [],
};

const REVERSE_EMERGENCY: Record<ChangeStatus, ChangeStatus[]> = {
  draft: [],
  awaiting_approval: ["draft"],
  approved: ["awaiting_approval", "draft"],
  in_progress: ["approved"],
  implemented: ["in_progress"],
  awaiting_pir: ["implemented"],
  completed: ["awaiting_pir"],
  cancelled: ["draft"],
  rejected: ["draft", "awaiting_approval"],
  rolled_back: [],
  // unused for emergency
  submitted: [],
  in_review: [],
  scheduled: [],
  awaiting_implementation: [],
  in_testing: [],
};

const REVERSIONS_BY_TRACK: Record<ChangeTrack, Record<ChangeStatus, ChangeStatus[]>> = {
  normal: REVERSE_NORMAL,
  standard: REVERSE_STANDARD,
  emergency: REVERSE_EMERGENCY,
};

export function listAllowedReversions(track: ChangeTrack, from: ChangeStatus): ChangeStatus[] {
  return Array.from(new Set(REVERSIONS_BY_TRACK[track][from] ?? []));
}

export function isReversionAllowed(track: ChangeTrack, from: ChangeStatus, to: ChangeStatus): boolean {
  return listAllowedReversions(track, from).includes(to);
}

export function isTransitionAllowed(track: ChangeTrack, from: ChangeStatus, to: ChangeStatus): boolean {
  if (TERMINAL_FROM_ANY.includes(to)) {
    // cancelled/rolled_back are reachable from any non-terminal, but not from another terminal
    const isTerminalNow = TRANSITIONS_BY_TRACK[track][from]?.length === 0;
    if (isTerminalNow) return false;
    if (to === "rolled_back") {
      // rolled_back only from execution/post-execution states
      return ["in_progress", "implemented", "in_testing", "awaiting_pir", "completed"].includes(from);
    }
    return true;
  }
  const allowed = TRANSITIONS_BY_TRACK[track][from] ?? [];
  return allowed.includes(to);
}

export function listAllowedTransitions(track: ChangeTrack, from: ChangeStatus): ChangeStatus[] {
  const base = TRANSITIONS_BY_TRACK[track][from] ?? [];
  return Array.from(new Set(base));
}

// Phase gates — additional checks beyond raw state-machine reachability.
// These are evaluated in changes.ts /transition handler. Returning a non-null string
// means "block with this 400 reason".
export type PhaseGateInputs = {
  track: ChangeTrack;
  toStatus: ChangeStatus;
  planning: { signedOff: boolean } | null;
  testing: {
    overallResult: string;
    cases: Array<{ status: "pending" | "passed" | "failed" | "blocked" }>;
  } | null;
  pir: { completedAt: Date | null } | null;
  approvalsAllApproved: boolean;
};

export function checkPhaseGates(p: PhaseGateInputs): string | null {
  // Approvals must be complete before leaving awaiting_approval to approved (normal/emergency).
  // (Already enforced by approvals.ts when last approval flips to approved.)
  // Cannot enter scheduled without an approved state having occurred (normal track).
  if (p.track === "normal" && p.toStatus === "scheduled" && !p.approvalsAllApproved) {
    return "All required approvals must be granted before scheduling.";
  }
  if (p.track === "emergency" && p.toStatus === "approved" && !p.approvalsAllApproved) {
    return "eCAB approval has not been recorded.";
  }
  // Normal track: the awaiting_approval -> approved flip itself must be gated
  // on every approval row being explicitly approved. Otherwise a Change Manager
  // (or admin) could click "→ Approved" on the status bar and skip the vote.
  // The auto-flip path in approvals.ts already enforces this when the last
  // vote lands; this guard catches the manual status-button path.
  if (p.track === "normal" && p.toStatus === "approved" && !p.approvalsAllApproved) {
    return "All required approvals must be recorded before the change can be marked Approved.";
  }
  // Defense in depth: even if a change has somehow been pre-flipped to
  // `approved`, we re-check that every approval row is explicitly approved
  // before allowing the Emergency change to be implemented. Abstains and
  // pending votes do NOT satisfy this gate.
  if (p.track === "emergency" && p.toStatus === "in_progress" && !p.approvalsAllApproved) {
    return "All eCAB approvals must be explicitly approved before implementation.";
  }
  // Same defense in depth for Normal: scheduling already requires it (above),
  // but in_progress should likewise reject abstains slipping through.
  if (p.track === "normal" && p.toStatus === "in_progress" && !p.approvalsAllApproved) {
    return "All required approvals must be explicitly approved before implementation.";
  }
  // Cannot enter in_progress on a normal change without planning sign-off.
  if (p.track === "normal" && p.toStatus === "in_progress") {
    if (!p.planning || !p.planning.signedOff) {
      return "Implementation cannot start until the planning record is signed off.";
    }
  }
  // Standard changes also require planning sign-off (they have prefilled planning, but it must be acknowledged).
  if (p.track === "standard" && p.toStatus === "in_progress") {
    if (!p.planning || !p.planning.signedOff) {
      return "Standard change requires the planning record to be signed off.";
    }
  }
  // Normal track: cannot enter awaiting_pir without the overall testing record
  // marked PASSED. The Tester explicitly takes responsibility for that flag —
  // we no longer require every individual case row to be marked passed (some
  // teams use the case grid for evidence/notes rather than as a strict gate).
  if (p.track === "normal" && p.toStatus === "awaiting_pir") {
    if (!p.testing || p.testing.overallResult !== "passed") {
      return "Testing must be marked PASSED before requesting PIR.";
    }
  }
  // Cannot mark completed without PIR completion.
  if ((p.track === "normal" || p.track === "emergency") && p.toStatus === "completed") {
    if (!p.pir || !p.pir.completedAt) {
      return "Post-Implementation Review must be completed before closing the change.";
    }
  }
  // Standard track: completion only from implemented (state machine already enforces); no PIR required.
  return null;
}
