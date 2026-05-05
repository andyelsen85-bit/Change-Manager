// Notification event keys — used both server-side (when sending) and surfaced
// in the user notification preferences UI.
export const NOTIFICATION_EVENTS: Array<{ key: string; label: string; description: string }> = [
  { key: "change.created", label: "Change created", description: "A new change request was drafted." },
  { key: "change.submitted", label: "Change submitted", description: "A change was submitted for review." },
  { key: "change.assigned", label: "Change assigned to you", description: "You were assigned to a change." },
  { key: "change.assignee_changed", label: "Change assignees changed", description: "Per-change assignees were updated." },
  { key: "change.transitioned", label: "Change status changed", description: "A change you watch transitioned." },
  { key: "change.scheduled", label: "Change scheduled", description: "A change was scheduled for implementation." },
  { key: "change.completed", label: "Change completed", description: "A change was closed (PIR completed)." },
  { key: "approval.requested", label: "Approval requested", description: "Your approval is required on a change." },
  { key: "approval.granted", label: "Approval granted", description: "An approver decided on a change you submitted." },
  { key: "approval.rejected", label: "Approval rejected", description: "An approver rejected a change you submitted." },
  { key: "cab.invited", label: "CAB meeting invitation", description: "You were invited to a CAB or eCAB meeting." },
  { key: "cab.reminder", label: "CAB meeting reminder", description: "A CAB or eCAB meeting is approaching." },
  { key: "cab.minutes", label: "CAB minutes published", description: "Minutes were posted after a meeting." },
  { key: "comment.added", label: "Comment added", description: "Someone commented on a change you watch." },
  { key: "pir.due", label: "PIR due", description: "A post-implementation review is due for a change." },
  { key: "test.signed_off", label: "Testing signed off", description: "Testing was completed for a change." },
];
