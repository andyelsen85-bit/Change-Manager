import { HelpCircle } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// Small inline "(?)" hint shown next to a field label. Renders a tooltip on
// hover/focus with the supplied criteria text. Shared by the change-creation
// form and the editable Details tab on the change-detail page.
export function FieldHint({ children, label }: { children: React.ReactNode; label?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label ?? "More information"}
          className="text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:text-foreground"
          data-testid="field-hint"
        >
          <HelpCircle className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs whitespace-pre-line text-left leading-relaxed">
        {children}
      </TooltipContent>
    </Tooltip>
  );
}

export const IMPACT_HINT = `1 — Low: A single workstation or isolated service · no critical system · no health data · downtime outside care hours · immediate rollback.

2 — Medium: Several services · important but non-vital system · short, planned downtime · tested rollback plan.

3 — High: Clinical or vital system · patient safety or continuity of care at stake · sensitive health data · downtime during care hours · complex or uncertain rollback.`;

export const PROBABILITY_HINT = `1 — Low: Routine action, already performed, proven procedure.

2 — Medium: Non-routine but documented and tested.

3 — High: Complex or new, lightly tested, multiple dependencies or involvement of an external provider.`;

export const PRIORITY_HINT = `How urgent this request is to handle. Determines the order in which it is taken on — independently of the risk score.`;

export const CATEGORY_HINT = `The functional domain of the request (network, application, infrastructure…). Used for classification and dashboards.`;

export const TRACK_HINT = `Standard: pre-approved, low risk, no CAB. Normal: full review (planning, approvals, CAB, testing, PIR). Emergency: expedited path with eCAB.`;
