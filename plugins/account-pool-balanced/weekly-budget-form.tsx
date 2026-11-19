import { useState } from "react";
import { weeklyRuleSchema, type AccountSummary, type WeeklyBudgetChange, type WeeklyRule } from "./src/contracts";
import { Button } from "./ui/components/ui/button";

const modeLabels = { pool: "Правило пула", fixed: "Фиксированный", scheduled: "По расписанию", override: "Ручной потолок", drain: "До исчерпания" };
export function weeklyModeLabel(account: AccountSummary) {
  return modeLabels[account.weeklySpending?.mode ?? (account.drainOnce ? "drain" : "pool")];
}

function ruleSteps(rule: WeeklyRule | undefined) {
  return rule?.mode === "scheduled"
    ? rule.steps.map(step => ({ hours: String(step.hoursBeforeReset), ceiling: String(step.ceiling) }))
    : [{ hours: "48", ceiling: "65" }, { hours: "24", ceiling: "80" }];
}

export function WeeklyBudgetForm({ account, save, deadline }: {
  account: AccountSummary;
  save: (input: WeeklyBudgetChange["change"], expected: WeeklyBudgetChange["expected"]) => Promise<void>;
  deadline: (timestamp: number) => string;
}) {
  const original = account.weeklyBudget?.rule;
  const current = account.weeklySpending;
  const [mode, setMode] = useState<"pool" | WeeklyRule["mode"]>(original?.mode ?? "pool");
  const [ceiling, setCeiling] = useState(String(original?.ceiling ?? 50));
  const [steps, setSteps] = useState(() => ruleSteps(original));
  const [editing, setEditing] = useState(false);
  const [manual, setManual] = useState(false);
  const [manualCeiling, setManualCeiling] = useState("");
  const [expiry, setExpiry] = useState<"next-step" | "reset">("reset");
  const [expected, setExpected] = useState(account.weeklyBudget ?? null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const resetAt = current?.resetAt ?? null;
  const isBillingPeriod = account.provider === "cursor";
  const title = isBillingPeriod ? "Правило расхода на цикл" : "Недельное правило";
  const hasNextStep = resetAt !== null && original?.mode === "scheduled" &&
    original.steps.some(step => resetAt - step.hoursBeforeReset * 3_600_000 > Date.now());

  async function submit(change: WeeklyBudgetChange["change"], close: () => void) {
    setPending(true);
    setError("");
    try {
      await save(change, change.kind === "clear-override" ? account.weeklyBudget ?? null : expected);
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось сохранить недельный потолок.");
    } finally {
      setPending(false);
    }
  }

  function startEditing() {
    setExpected(account.weeklyBudget ?? null);
    setMode(original?.mode ?? "pool");
    setCeiling(String(original?.ceiling ?? 50));
    setSteps(ruleSteps(original));
    setError("");
    setManual(false);
    setEditing(value => !value);
  }

  return (
    <section className="pool-settings-section" aria-label={title}>
      <h4 className="pool-settings-heading">{title}</h4>
      <p className="text-sm">
        {weeklyModeLabel(account)}
        {current ? " · потолок " + Number((current.ceiling * 100).toFixed(1)) + "%" : ""}
        {current?.mode === "override" && current.nextChangeAt !== null
          ? " · действует до " + deadline(current.nextChangeAt)
          : ""}
      </p>
      {current?.mode === "scheduled" && current.nextChangeAt !== null && current.nextChangeAt !== current.resetAt &&
        <p className="pool-settings-help">Следующая ступень · {deadline(current.nextChangeAt)}</p>}
      {original?.mode === "scheduled" && (
        <ul className="space-y-1 text-xs text-muted-foreground">
          <li>{isBillingPeriod ? "Начало цикла" : "Начало недели"} · до {original.ceiling}%</li>
          {original.steps.map(step => <li key={step.hoursBeforeReset}>За {step.hoursBeforeReset} ч до сброса · до {step.ceiling}%</li>)}
        </ul>
      )}
      {resetAt === null && <p className="pool-settings-help">{isBillingPeriod ? "Сброс расчётного периода" : "Недельный сброс"} пока неизвестен.{original?.mode === "scheduled" && " Действует начальный потолок. Время ступеней определится после получения даты сброса."}</p>}
      <div className="pool-settings-schedule-actions">
        <Button type="button" size="sm" variant="outline" aria-expanded={editing} disabled={pending} onClick={startEditing}>
          {editing ? "Скрыть редактор" : isBillingPeriod ? "Изменить правило на цикл" : "Изменить недельное правило"}
        </Button>
        {original && <Button type="button" size="sm" variant="outline" aria-expanded={manual} disabled={pending || resetAt === null || !!account.drainOnce} onClick={() => {
          setExpected(account.weeklyBudget ?? null);
          setError("");
          setEditing(false);
          setManualCeiling(String(Number(((current?.ceiling ?? original.ceiling / 100) * 100).toFixed(2))));
          setExpiry(hasNextStep ? "next-step" : "reset");
          setManual(value => !value);
        }}>Изменить потолок сейчас</Button>}
        {current?.mode === "override" && <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => void submit({ kind: "clear-override" }, () => setManual(false))}>Вернуть правило</Button>}
      </div>
      {editing && (
        <form className="pool-settings-fields" onSubmit={event => {
          event.preventDefault();
          if (mode === "pool") {
            void submit({ kind: "rule", rule: null }, () => setEditing(false));
            return;
          }
          const parsed = weeklyRuleSchema.safeParse(mode === "fixed"
            ? { mode, ceiling: Number(ceiling) }
            : { mode, ceiling: Number(ceiling), steps: steps.map(step => ({ hoursBeforeReset: Number(step.hours), ceiling: Number(step.ceiling) })) });
          if (!parsed.success) {
            setError("Часы до сброса должны уменьшаться, а потолок расхода на каждой ступени — оставаться прежним или расти.");
            return;
          }
          void submit({ kind: "rule", rule: parsed.data }, () => setEditing(false));
        }}>
          <fieldset disabled={pending} className="pool-settings-fields">
            <label className="pool-settings-field">Режим
              <select className="pool-settings-control" value={mode} onChange={event => setMode(event.target.value as typeof mode)}>
                <option value="pool">Правило пула</option>
                <option value="fixed">Фиксированный</option>
                <option value="scheduled">По расписанию</option>
              </select>
            </label>
            {mode !== "pool" && <label className="pool-settings-field">{mode === "fixed" ? "Потолок расхода, %" : isBillingPeriod ? "Потолок в начале цикла, %" : "Потолок в начале недели, %"}
              <input className="pool-settings-control" type="number" min={0} max={100} step="any" required value={ceiling} onChange={event => setCeiling(event.target.value)} />
            </label>}
            {mode === "scheduled" && <>
              {steps.map((step, index) => (
                <div className="pool-weekly-step" key={index}>
                  <label className="pool-settings-field">Часов до сброса
                    <input className="pool-settings-control" aria-label={"Часов до сброса, ступень " + (index + 1)} type="number" min={1} max={167} required value={step.hours} onChange={event => setSteps(values => values.map((value, i) => i === index ? { ...value, hours: event.target.value } : value))} />
                  </label>
                  <label className="pool-settings-field">Потолок, %
                    <input className="pool-settings-control" aria-label={"Потолок, ступень " + (index + 1)} type="number" min={0} max={100} step="any" required value={step.ceiling} onChange={event => setSteps(values => values.map((value, i) => i === index ? { ...value, ceiling: event.target.value } : value))} />
                  </label>
                  <Button type="button" size="sm" variant="ghost" className="pool-settings-remove" disabled={steps.length === 1} aria-label={"Удалить ступень " + (index + 1)} onClick={() => setSteps(values => values.filter((_, i) => i !== index))}>×</Button>
                </div>
              ))}
              <Button type="button" size="sm" variant="outline" disabled={steps.length >= 14} onClick={() => setSteps(values => [...values, { hours: "", ceiling: "" }])}>Добавить ступень</Button>
            </>}
            {mode !== "pool" && <p className="pool-settings-help">Это правило задаёт общий потолок аккаунта на {isBillingPeriod ? "расчётный цикл" : "неделю"}. Прежняя настройка запаса сохранится для квот моделей и вернётся для общей квоты в режиме «Правило пула».</p>}
            <Button type="submit" size="sm">{isBillingPeriod ? "Сохранить правило на цикл" : "Сохранить недельное правило"}</Button>
          </fieldset>
        </form>
      )}
      {manual && (
        <form className="pool-settings-fields" onSubmit={event => {
          event.preventDefault();
          void submit({ kind: "override", ceiling: Number(manualCeiling), until: hasNextStep ? expiry : "reset" }, () => setManual(false));
        }}>
          <fieldset disabled={pending || resetAt === null || !!account.drainOnce} className="pool-settings-fields">
            <label className="pool-settings-field">Временный потолок, %
              <input className="pool-settings-control" type="number" min={0} max={100} step="any" required value={manualCeiling} onChange={event => setManualCeiling(event.target.value)} />
            </label>
            <label className="pool-settings-field">Действует
              <select className="pool-settings-control" value={hasNextStep ? expiry : "reset"} onChange={event => setExpiry(event.target.value as typeof expiry)}>
                {hasNextStep && <option value="next-step">До следующей ступени</option>}
                <option value="reset">{isBillingPeriod ? "До сброса цикла" : "До недельного сброса"}</option>
              </select>
            </label>
            <Button type="submit" size="sm">Применить временный потолок</Button>
          </fieldset>
        </form>
      )}
      {error && <p role="alert" className="pool-settings-error">{error}</p>}
    </section>
  );
}
