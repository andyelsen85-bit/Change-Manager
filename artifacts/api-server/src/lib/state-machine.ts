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

// Emergency: collapsed flow, eCAB approval may run in parallel with implementation
// (recorded retroactively), so we permit jumping from draft straight to in_progress.
const EMERGENCY: Record<ChangeStatus, ChangeStatus[]> = {
  draft: ["awaiting_approval", "in_progress", "cancelled"],
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
  testing: { overallResult: string } | null;
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
  // Normal track: cannot enter awaiting_pir without testing passed.
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
