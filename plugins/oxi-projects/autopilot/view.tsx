import {useRpc} from "./rpc";
import type { Snapshot } from "./model";
import type { ProjectDetail, Run, workSummary } from "./work";
export const number = (v: number | null) => (v === null ? "—" : String(v));
export const date = (v: string | null) =>
  v && Number.isFinite(Date.parse(v))
    ? new Date(v).toLocaleString("ru-RU", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "нет данных";
export const ago = (v: string | null, now: number) => {
  if (!v || !Number.isFinite(Date.parse(v))) return "нет отчёта";
  const m = Math.max(0, Math.floor((now - Date.parse(v)) / 60000));
  return m < 1
    ? "только что"
    : m < 60
      ? `${m} мин назад`
      : m < 1440
        ? `${Math.floor(m / 60)} ч назад`
        : `${Math.floor(m / 1440)} дн назад`;
};
export const modes = {
  enabled: "Включён",
  disabled: "Выключен",
  paused: "На паузе",
  unknown: "Настройки требуют проверки",
};
export const tones = {
  muted: "bg-surface-recessed text-muted-foreground",
  warning: "bg-surface-recessed text-foreground",
  success: "bg-surface-recessed text-foreground",
  error: "bg-destructive/10 text-destructive",
};
export type Row = {
  key: string;
  snapshot: Snapshot;
  project: NonNullable<Snapshot["data"]>["status"]["projects"][number];
  runs: Run[];
  summary: ReturnType<typeof workSummary>;
};
export type DetailState = {
  data: ProjectDetail | null;
  error: string | null;
  loading: boolean;
};
export function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card p-4 space-y-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}
export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-sm text-muted-foreground leading-relaxed">{children}</p>
  );
}
export function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      <p className="text-xs text-muted-foreground mt-1">{label}</p>
    </div>
  );
}

export const readableTimes = (text: string) => text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g, value => date(value));
