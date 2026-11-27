import type { ReactNode } from "react";
import { ResourceRowDetailChevron } from "./ui/components/ui/resource/row";
import { cn } from "./ui/lib/utils";

export function SettingsBadge({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded-sm border border-border bg-muted/40 px-1.5 py-0.5 text-2xs leading-none text-subtle-foreground">
      {children}
    </span>
  );
}

export function AccountListRow({
  name,
  enabled,
  leading,
  badges,
  description,
  status,
  metrics,
  actions,
  onOpen,
  expanded,
  controls,
}: {
  name: string;
  enabled: boolean;
  leading?: ReactNode;
  badges: ReactNode;
  description?: ReactNode;
  status: ReactNode;
  metrics: ReactNode;
  actions: ReactNode;
  onOpen: () => void;
  expanded?: boolean;
  controls?: string;
}) {
  return (
    <div className="flex items-start gap-2 text-sm">
      {leading ?? <span aria-hidden="true" className="w-8 shrink-0" />}
      <div className={cn(
        "group -mx-2 flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-2.5 transition-colors hover:bg-state-hover focus-within:bg-state-hover",
        !enabled && "opacity-55",
      )}>
        <button
          type="button"
          className="grid min-w-0 flex-1 grid-cols-1 items-center gap-y-1.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Открыть ${name}`}
          aria-expanded={expanded}
          aria-controls={controls}
          onClick={onOpen}
        >
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="w-full min-w-0 text-sm font-medium text-foreground [overflow-wrap:anywhere] sm:w-auto">
                {name}
              </span>
              {badges}
            </div>
            {description}
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-subtle-foreground/75">
              {status}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 sm:gap-1">
            {metrics}
          </div>
        </button>
        {actions}
        <button type="button" className="shrink-0 rounded-md px-1.5 py-1 text-xs hover:bg-muted" aria-label={`${expanded ? "Свернуть карточку" : "Открыть карточку"}: ${name}`} aria-expanded={expanded} aria-controls={controls} onClick={onOpen}>
          {expanded === undefined ? <ResourceRowDetailChevron /> : expanded ? "Свернуть" : "Детали"}
        </button>
      </div>
    </div>
  );
}

export function QuotaEmpty({ state }: { state: "error" | "no-data" | "pending" | "not-connected" }) {
  const labels = {
    error: "Ошибка сбора квот",
    "no-data": "Источник не отдаёт данные о квотах",
    pending: "Данные о квотах ещё не получены",
    "not-connected": "Pooler пока не получает квоты",
  };
  return <span className={cn("text-xs", state === "error" ? "text-destructive-text" : "text-muted-foreground")}>{labels[state]}</span>;
}

export function AccountRowStatus({ label, dot }: { label: string; dot: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", dot)} />
      {label}
    </span>
  );
}
