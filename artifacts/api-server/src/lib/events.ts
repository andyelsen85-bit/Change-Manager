// Notification event keys — used both server-side (when sending) and surfaced
// in the user notification preferences UI.
export const NOTIFICATION_EVENTS: Array<{ key: string; label: string; description: string }> = [
  { key: "change.submitted", label: "Change submitted", description: "A change was submitted for review." },
  { key: "change.cancelled", label: "Change cancelled", description: "A change was cancelled." },
  { key: "change.completed", label: "Change completed", description: "A change was closed (PIR completed)." },
  { key: "approval.requested", label: "Approval requested", description: "Your approval is required on a change." },
  { key: "approval.granted", label: "Approval granted", description: "The Change Manager approved a change you submitted." },
  { key: "cab.invited", label: "CAB meeting invitation", description: "You were invited to a CAB or eCAB meeting." },
  { key: "cab.reminder", label: "CAB meeting reminder", description: "A CAB or eCAB meeting is approaching." },
  { key: "cab.minutes", label: "CAB minutes published", description: "Minutes were posted after a meeting." },
  { key: "comment.added", label: "Comment added", description: "Someone commented on a change you watch." },
  { key: "pir.due", label: "PIR due", description: "A post-implementation review is due for a change." },
  { key: "test.signed_off", label: "Production testing passed", description: "Production testing was signed off as passed." },
  { key: "pentest.requested", label: "PenTest request opened", description: "A new penetration-test request was opened." },
  { key: "pentest.status_changed", label: "PenTest status changed", description: "A penetration-test request moved to a new status." },
];
