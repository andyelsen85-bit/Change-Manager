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

export const IMPACT_HINT = `1 — Faible : Un seul poste ou service isolé · aucun système critique · pas de données de santé · indisponibilité hors heures de soin · retour arrière immédiat.

2 — Moyen : Plusieurs services · système important mais non vital · indisponibilité courte et planifiée · plan de retour arrière testé.

3 — Fort : Système clinique ou vital · sécurité du patient ou continuité des soins en jeu · données de santé sensibles · indisponibilité pendant les heures de soin · retour arrière complexe ou incertain.`;

export const PROBABILITY_HINT = `1 — Faible : Geste routinier, déjà réalisé, procédure éprouvée.

2 — Moyenne : Non routinier mais documenté et testé.

3 — Forte : Complexe ou nouveau, peu testé, dépendances multiples ou intervention d'un prestataire externe.`;

export const PRIORITY_HINT = `Combien cette demande est urgente à traiter. Détermine l'ordre de prise en charge — indépendamment du score de risque.`;

export const CATEGORY_HINT = `Le domaine fonctionnel de la demande (réseau, application, infrastructure…). Utilisé pour le classement et les tableaux de bord.`;

export const TRACK_HINT = `Standard : pré-approuvé, faible risque, sans CAB. Normal : revue complète (planning, approbations, CAB, tests, PIR). Emergency : voie accélérée avec eCAB.`;
