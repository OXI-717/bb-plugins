import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  useRpc,
  useBbNavigate,
  experimental_ProviderModelPicker as ModelPicker,
  experimental_NewThreadComposer as NewThreadComposer,
  experimental_ProviderIcon as ProviderIcon,
  experimental_Icon as Icon,
  type ExperimentalProviderModelPickerValue as Selection,
  type PluginThreadPanelProps,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import type { contract, catalogOutput, rowSchema } from "./contract";
import "./app.css";

type Catalog = z.infer<typeof catalogOutput>;
type Row = z.infer<typeof rowSchema>;
const reasoning = z.enum(["none", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"]);
export function ConnectionsPanel({
  threadId,
  projectId,
}: {
  threadId?: string;
  projectId?: string | null;
}) {
  const rpc = useRpc<typeof contract>();
  const navigate = useBbNavigate();
  const [hostId, setHostId] = useState<string>();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const generation = useRef(0);
  const alive = useRef(true);
  const creationId = useRef(crypto.randomUUID());
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, []);
  const refresh = useCallback(async () => {
    const version = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const result = await rpc.call(
        "catalog",
        threadId ? { threadId } : { hostId },
      );
      if (alive.current && version === generation.current) setCatalog(result);
    } catch {
      if (alive.current && version === generation.current) {
        setError("Не удалось обновить подключения. Попробуйте ещё раз.");
        setCatalog(null);
      }
    } finally {
      if (alive.current && version === generation.current) setLoading(false);
    }
  }, [rpc, threadId, hostId]);
  useEffect(() => {
    setSelectedId(null);
    setSelection(null);
    setCreating(false);
    void refresh();
  }, [refresh]);
  const chosen =
    catalog?.connections.find((row) => row.id === selectedId) ?? null;
  const select = (row: Row) => {
    setSelectedId(row.id);
    setSelection({ providerId: row.id, model: "", reasoningLevel: "medium" });
    setCreating(false);
    setNotice("");
    setError("");
  };
  async function visibility(row: Row) {
    if (!catalog || busy) return;
    setBusy(true);
    setError("");
    try {
      await rpc.call("visibility", {
        hostId: catalog.hostId,
        providerId: row.id,
        hidden: !row.hidden,
      });
      await refresh();
    } catch {
      if (alive.current)
        setError("Не удалось сохранить видимость подключения.");
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function apply() {
    if (!threadId || !chosen || !selection || busy) return;
    setBusy(true);
    setError("");
    try {
      await rpc.call("apply", {
        threadId,
        providerId: selection.providerId,
        model: selection.model,
        reasoningLevel: reasoning.parse(selection.reasoningLevel),
        expectedGroup: chosen.group,
      });
      if (alive.current)
        setNotice("Модель выбрана. Она применится со следующего хода.");
    } catch {
      if (alive.current)
        setError(
          "Не удалось применить выбор. Обновите подключения и проверьте модель.",
        );
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const rows = catalog?.connections ?? [];
  const match = (row: Row) =>
    `${row.name} ${row.detail}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase());
  const card = (row: Row) => (
    <div
      className={`mc-row ${selectedId === row.id ? "mc-selected" : ""}`}
      key={row.id}
    >
      <button
        className="mc-connection"
        type="button"
        disabled={!row.selectable || busy}
        onClick={() => select(row)}
        aria-pressed={selectedId === row.id}
      >
        <span className="mc-brand" aria-hidden="true">
          {row.mark ? (
            <span className="mc-mark">{row.mark}</span>
          ) : (
            <ProviderIcon
              providerKind="agent"
              provider={{
                id: row.id,
                logoUrl: row.logoUrl,
                icon: { glyph: row.icon },
              }}
              className="mc-icon"
            />
          )}
        </span>
        <span className="mc-row-copy">
          <strong>{row.name}</strong>
          <small>
            {row.detail}
            {catalog?.currentProviderId === row.id ? " · Текущий движок" : ""}
          </small>
        </span>
        {selectedId === row.id ? (
          <Icon name="Check" className="mc-check" />
        ) : null}
      </button>
      <button
        type="button"
        className="mc-visibility"
        disabled={busy}
        onClick={() => void visibility(row)}
        aria-label={`${row.hidden ? "Показать" : "Скрыть"} ${row.name}`}
        title={
          row.hidden ? "Показать в списке" : "Скрыть только в этом выборщике"
        }
      >
        <Icon name={row.hidden ? "Eye" : "EyeOff"} className="mc-icon" />
      </button>
    </div>
  );
  const canApply = threadId && chosen?.id === catalog?.currentProviderId;
  const extraTier =
    selection?.serviceTier !== undefined && selection.serviceTier !== "default";
  if (creating && selection && chosen && catalog)
    return (
      <section className="mc-root mc-create">
        <button
          type="button"
          className="mc-button"
          onClick={() => setCreating(false)}
        >
          ← К подключениям
        </button>
        <h2>{threadId ? "Продолжить в новом треде" : "Новый тред"}</h2>
        <NewThreadComposer
          defaultProjectId={catalog.projectId ?? projectId ?? undefined}
          defaultProviderId={selection.providerId}
          defaultModel={selection.model}
          defaultReasoningLevel={selection.reasoningLevel}
          defaultServiceTier={selection.serviceTier}
          defaultEnvironment={
            catalog.environmentId
              ? { type: "reuse", environmentId: catalog.environmentId }
              : {
                  type: "host",
                  hostId: catalog.hostId,
                  workspace: { type: "unmanaged", path: null },
                }
          }
          initialPrompt={
            threadId
              ? `Continue the work from @thread:${threadId}. Check the current state before repeating any actions.`
              : undefined
          }
          draftKey={`model-connections:${threadId ?? "new"}:${catalog.hostId}`}
          layout="document"
          onSubmit={async (request) => {
            const result = await rpc.call("create", {
              request,
              requestId: creationId.current,
              expectedProviderId: chosen.id,
              expectedGroup: chosen.group,
              ...(threadId ? { sourceThreadId: threadId } : {}),
            });
            creationId.current = crypto.randomUUID();
            navigate.toThread(result.threadId);
          }}
        />
      </section>
    );
  return (
    <section className="mc-root" aria-label="Выбор модели">
      <header className="mc-header">
        <div>
          <h2>Модели</h2>
          <p>Выберите подключение и модель</p>
        </div>
        <button
          type="button"
          className="mc-button mc-refresh"
          onClick={() => void refresh()}
          disabled={loading || busy}
          aria-label="Обновить подключения"
        >
          <Icon name="RefreshCw" className="mc-icon" />
        </button>
      </header>
      {catalog && !threadId ? (
        <label className="mc-host">
          Машина
          <select
            value={catalog.hostId}
            disabled={busy}
            onChange={(e) => setHostId(e.target.value)}
          >
            {catalog.hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <input
        className="mc-search"
        aria-label="Найти подключение"
        placeholder="Найти подключение…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {error ? (
        <p className="mc-error" role="alert">
          {error}
        </p>
      ) : null}
      {loading ? (
        <p className="mc-muted" role="status">
          Проверяю подключения…
        </p>
      ) : null}
      {catalog && !catalog.poolAvailable ? (
        <p className="mc-muted">
          Пул сейчас недоступен. Его подключения не будут выданы за локальные.
        </p>
      ) : null}
      <div className="mc-list">
        {(["local", "pool"] as const).map((group) => {
          const items = rows.filter(
            (row) =>
              row.group === group &&
              row.selectable &&
              !row.hidden &&
              match(row),
          );
          return (
            <div className="mc-group" key={group}>
              <h3>
                {group === "local" ? "Локальные подключения" : "Pooler"}
                <span>{items.length}</span>
              </h3>
              {items.length ? (
                items.map(card)
              ) : (
                <p className="mc-empty">
                  {loading ? "Загрузка…" : "Нет подходящих подключений"}
                </p>
              )}
            </div>
          );
        })}
        {rows.some((r) => (!r.selectable || r.hidden) && match(r)) ? (
          <details className="mc-unavailable">
            <summary>
              Скрытые и недоступные ·{" "}
              {
                rows.filter((r) => (!r.selectable || r.hidden) && match(r))
                  .length
              }
            </summary>
            {rows
              .filter((r) => (!r.selectable || r.hidden) && match(r))
              .map(card)}
          </details>
        ) : null}
      </div>
      {chosen && selection ? (
        <div className="mc-choice">
          <h3>{chosen.name}</h3>
          <ModelPicker
            value={selection}
            onChange={setSelection}
            allowProviderChange={false}
            routing={
              catalog?.environmentId
                ? { kind: "environment", environmentId: catalog.environmentId }
                : { kind: "host", hostId: catalog!.hostId }
            }
          />
          <p className="mc-muted">
            {canApply
              ? "Изменение не прервёт текущий ответ."
              : "Другой движок продолжит работу в новом треде."}
          </p>
          {extraTier && canApply ? (
            <p className="mc-muted">
              Выбранный режим скорости можно использовать при создании нового
              треда.
            </p>
          ) : null}
          <div className="mc-actions">
            {canApply ? (
              <button
                type="button"
                className="mc-primary"
                disabled={
                  busy ||
                  loading ||
                  !selection.model ||
                  extraTier ||
                  !chosen.selectable ||
                  chosen.hidden
                }
                onClick={() => void apply()}
              >
                {busy ? "Сохраняю…" : "Применить со следующего хода"}
              </button>
            ) : null}
            <button
              type="button"
              className={canApply ? "mc-button" : "mc-primary"}
              disabled={
                busy ||
                loading ||
                !selection.model ||
                !chosen.selectable ||
                chosen.hidden
              }
              onClick={() => setCreating(true)}
            >
              {threadId ? "Продолжить в новом треде" : "Создать тред"}
            </button>
          </div>
        </div>
      ) : null}
      {notice ? (
        <p className="mc-notice" role="status">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
function HeaderButton() {
  const navigate = useBbNavigate();
  return (
    <button
      type="button"
      className="mc-header-button"
      onClick={() =>
        navigate.openThreadPanel({ actionId: "connections", title: "Модели" })
      }
    >
      <Icon name="Layers" className="mc-icon" />
      <span>Модели</span>
    </button>
  );
}
export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "models",
    title: "Модели",
    component: HeaderButton,
  });
  app.slots.threadPanelAction({
    id: "connections",
    title: "Модели",
    component: ({ threadId }: PluginThreadPanelProps) => (
      <ConnectionsPanel threadId={threadId} />
    ),
    run: ({ openPanel }) => {
      openPanel({ title: "Модели" });
    },
  });
  app.slots.experimental_newThreadPanelAction({
    id: "connections",
    title: "Модели",
    component: ({ projectId }) => <ConnectionsPanel projectId={projectId} />,
    run: ({ openPanel }) => {
      openPanel({ title: "Модели" });
    },
  });
  app.slots.navPanel({
    id: "connections",
    path: "models",
    title: "Модели",
    icon: "Layers",
    component: () => <ConnectionsPanel />,
  });
});
