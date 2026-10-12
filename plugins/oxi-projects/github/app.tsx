import { date as displayDate } from "../autopilot/view";
import {WorkActions} from "../work-actions";
import {useRpc} from "./rpc";
import { Fragment, useEffect, useState } from "react";
import {
  definePluginApp,

  useBbContext,
  useBbNavigate,
  type PluginNavPanelProps,
  type PluginHomepageSectionProps,
  Markdown,
  experimental_Diff as Diff,
  UrlLink,
} from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import {
  contract,
  project as projectSchema,
  type Project,
  item,
  detail,
} from "./contract";
import { Button } from "./components/ui/button";
type Item = z.infer<typeof item>;
type Detail = z.infer<typeof detail>;
const field = "rounded-md border border-border bg-background px-3 py-2 text-sm";
export function Editor({
  initial,
  accounts,
  onSave,
  onCancel,
  showAutopilot=false,
}: {
  initial: Project;
  accounts: string[];
  showAutopilot?: boolean;
  onSave: (p: Project) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, set] = useState(initial),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  return (
    <section className="rounded-xl border border-border p-4 space-y-4">
      <h2 className="font-semibold">Проект и доступ к репозиториям</h2>
      <label className="block text-sm">
        Название проекта
        <input
          aria-label="Название проекта"
          className={`${field} block mt-1 w-full`}
          value={value.name}
          onChange={(e) => set({ ...value, name: e.target.value })}
        />
      </label>
      <p className="text-sm text-muted-foreground">
        Каждый репозиторий запрашивается под указанным аккаунтом. Здесь
        выбираются аккаунты, уже авторизованные в GitHub CLI на хосте BB.
      </p>
      {showAutopilot&&<label className="block text-sm">Проект автопилота<input aria-label="Проект автопилота" className={`${field} block mt-1 w-full`} placeholder="Например, example-project" value={value.autopilotProject??""} onChange={e=>set({...value,autopilotProject:e.target.value.trim()||null})}/></label>}
      {value.repositories.map((r, i) => (
        <div key={i} className="flex flex-wrap gap-2">
          <input
            aria-label={`Репозиторий ${i + 1}`}
            className={`${field} flex-1`}
            placeholder="owner/repository"
            value={r.repo}
            onChange={(e) =>
              set({
                ...value,
                repositories: value.repositories.map((x, j) =>
                  i === j ? { ...x, repo: e.target.value.trim() } : x,
                ),
              })
            }
          />
          <select
            aria-label={`Аккаунт ${i + 1}`}
            className={field}
            value={r.account}
            onChange={(e) =>
              set({
                ...value,
                repositories: value.repositories.map((x, j) =>
                  i === j ? { ...x, account: e.target.value } : x,
                ),
              })
            }
          >
            <option value="">Выбери аккаунт</option>
            {[
              ...new Set([
                ...accounts,
                ...value.repositories.map((r) => r.account).filter(Boolean),
              ]),
            ].map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
          <Button
            variant="outline"
            onClick={() =>
              set({
                ...value,
                repositories: value.repositories.filter((_, j) => j !== i),
              })
            }
          >
            Убрать
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        onClick={() =>
          set({
            ...value,
            repositories: [
              ...value.repositories,
              { repo: "", account: accounts.length === 1 ? accounts[0] : "" },
            ],
          })
        }
      >
        Добавить репозиторий
      </Button>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            setError("");
            try {
              await onSave(projectSchema.parse(value));
            } catch (e) {
              setError(
                e instanceof z.ZodError
                  ? "Проверь название, owner/repository и аккаунт. Репозитории не должны повторяться."
                  : String(e),
              );
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? "Сохраняется…" : "Сохранить проект"}
        </Button>
        <Button variant="outline" onClick={onCancel}>
          Отмена
        </Button>
      </div>
    </section>
  );
}
function Content({ value, projectId }: { value: Detail; projectId: string|null }) {
  return (
    <article className="space-y-5 border-t border-border pt-5">
      <header>
        <p className="text-xs text-muted-foreground">
          {value.repo} · #{value.number} · {value.state} · {value.author}
        </p>
        <h2 className="text-xl font-semibold mt-1">{value.title}</h2>
        <UrlLink href={value.url}>Открыть на GitHub</UrlLink>
      </header>
      <Markdown content={value.body || "Описание отсутствует."} />
      {projectId&&<WorkActions reference={{projectId,source:'github',kind:'files' in value?'pr':'issue',locator:`${value.repo}#${value.number}`}}/>}
      {"checks" in value && (
        <>
          <p className="text-sm">
            {value.headRefName} → {value.baseRefName} · +{value.additions} / −
            {value.deletions} · {value.reviewDecision || "Решения ревью нет"} ·{" "}
            {value.mergeStateStatus}
          </p>
          <section>
            <h3 className="font-semibold mb-2">Проверки</h3>
            {value.checks.length ? (
              value.checks.map((c, i) => (
                <p key={i} className="text-sm">
                  {c.status} · {c.name}
                </p>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">Проверок нет</p>
            )}
          </section>
        </>
      )}
      <section className="space-y-3">
        <h3 className="font-semibold">Обсуждение</h3>
        {!value.comments.length && (
          <p className="text-sm text-muted-foreground">Комментариев нет</p>
        )}
        {value.comments.map((c, i) => (
          <div key={i} className="rounded-lg border border-border p-3">
            <p className="text-xs text-muted-foreground mb-2">
              {c.author} · {displayDate(c.createdAt)}
            </p>
            <Markdown content={c.body} />
          </div>
        ))}
      </section>
      {"reviews" in value && (
        <>
          <section className="space-y-3">
            <h3 className="font-semibold">Ревью</h3>
            {value.reviews.map((r, i) => (
              <div key={i} className="border border-border rounded-lg p-3">
                <p className="text-sm mb-2">
                  {r.author} · {r.state}
                </p>
                <Markdown content={r.body} />
              </div>
            ))}
            {value.reviewThreads.map((r, i) => (
              <div
                key={i}
                className="border border-border rounded-lg p-3 space-y-2"
              >
                <p className="text-sm">
                  {r.path}:{r.line ?? ""}
                </p>
                {r.diffHunk && <Diff path={r.path} patch={r.diffHunk} />}{" "}
                {r.comments.map((c, j) => (
                  <div key={j}>
                    <p className="text-xs text-muted-foreground">{c.author}</p>
                    <Markdown content={c.body} />
                  </div>
                ))}
              </div>
            ))}
          </section>
          <section className="space-y-4">
            <h3 className="font-semibold">
              Изменённые файлы · {value.changedFiles}
            </h3>
            {value.files.map((f) => (
              <div key={f.path}>
                <p className="text-sm font-medium mb-2">
                  {f.path} · +{f.additions} / −{f.deletions}
                </p>
                {f.patch ? (
                  <Diff path={f.path} patch={f.patch} />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    GitHub не предоставил текстовый дифф или он превышает лимит
                    предпросмотра.
                  </p>
                )}
              </div>
            ))}
          </section>
        </>
      )}
    </article>
  );
}
export function ProjectView({ project, itemKind }: { project: Project; itemKind?: "issue" | "pr" }) {
  const rpc = useRpc<typeof contract>();
  const [kind, setKind] = useState<"issue" | "pr">(itemKind ?? "pr"),
    [state, setState] = useState<"open" | "closed" | "all">("open"),
    [repos, setRepos] = useState<string[]>([]),
    [account, setAccount] = useState(""),
    [query, setQuery] = useState(""),
    [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{
      items: Item[];
      errors: { repo: string; account: string; message: string }[];
      limited: string[];
      at: string;
    } | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [selected, setSelected] = useState<Item | null>(null),
    [value, setValue] = useState<Detail | null>(null),
    [readError, setReadError] = useState("");
  const key = JSON.stringify([
    project.id,
    project.repositories,
    kind,
    state,
    repos,
    account,
    refresh,
  ]);
  useEffect(() => {
    let live = true;
    setResult(null);
    setSelected(null);
    setValue(null);
    setError("");
    setLoading(true);
    rpc
      .call("list", {
        projectId: project.id,
        kind,
        state,
        repos,
        account: account || null,
      })
      .then(
        (r) => {
          if (live) setResult(r);
        },
        (e) => {
          if (live) setError(String(e));
        },
      )
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [rpc, key]);
  useEffect(() => {
    let live = true;
    setValue(null);
    setReadError("");
    if (selected)
      rpc
        .call("read", {
          projectId: project.id,
          repo: selected.repo,
          kind: selected.kind,
          number: selected.number,
        })
        .then(
          (v) => {
            if (live) setValue(v);
          },
          (e) => {
            if (live) setReadError(String(e));
          },
        );
    return () => {
      live = false;
    };
  }, [rpc, selected, project.id]);
  const filtered =
    result?.items.filter((i) =>
      `${i.title} #${i.number} ${i.repo} ${i.author} ${i.labels.join(" ")} ${i.assignees.join(" ")}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    ) ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {!itemKind && <><Button
          variant={kind === "pr" ? "default" : "outline"}
          onClick={() => setKind("pr")}
        >
          Pull requests
        </Button>
        <Button
          variant={kind === "issue" ? "default" : "outline"}
          onClick={() => setKind("issue")}
        >
          Задачи
        </Button></>}
        <select
          aria-label="Состояние"
          className={field}
          value={state}
          onChange={(e) => setState(e.target.value as typeof state)}
        >
          <option value="open">Открытые</option>
          <option value="closed">Закрытые</option>
          <option value="all">Все состояния</option>
        </select>
        <select
          aria-label="Фильтр аккаунтов"
          className={field}
          value={account}
          onChange={(e) => setAccount(e.target.value)}
        >
          <option value="">Все аккаунты проекта</option>
          {[...new Set(project.repositories.map((r) => r.account))].map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
        <Button
          variant="outline"
          disabled={loading}
          onClick={() => setRefresh((r) => r + 1)}
        >
          Обновить
        </Button>
      </div>
      <div className="flex flex-wrap gap-2" aria-label="Репозитории проекта">
        <Button
          variant={!repos.length ? "default" : "outline"}
          onClick={() => setRepos([])}
        >
          Все репозитории · {project.repositories.length}
        </Button>
        {project.repositories.map((r) => (
          <Button
            key={r.repo}
            variant={repos.includes(r.repo) ? "default" : "outline"}
            onClick={() =>
              setRepos((old) =>
                old.includes(r.repo)
                  ? old.filter((x) => x !== r.repo)
                  : [...old, r.repo],
              )
            }
          >
            {r.repo} · {r.account}
          </Button>
        ))}
      </div>
      <input
        className={`${field} w-full`}
        aria-label="Поиск"
        placeholder="Поиск по названию, номеру, автору, меткам и исполнителю"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {loading && <p role="status">Загружаем выбранный проект…</p>}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {result?.errors.map((e) => (
        <p role="alert" className="text-destructive text-sm" key={e.repo}>
          {e.repo} · {e.account}: {e.message}
        </p>
      ))}
      {result?.limited.length ? (
        <p className="text-sm text-muted-foreground">
          Показаны последние 100 записей на репозиторий:{" "}
          {result.limited.join(", ")}.
        </p>
      ) : null}
      {result && (
        <p className="text-xs text-muted-foreground">
          {filtered.length} записей · проверено{" "}
          {displayDate(result.at)}
        </p>
      )}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(22rem,2fr)] items-start">
        <div className="min-w-0">
          <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground border-b border-border">
              <th className="p-2">PR / задача</th>
              <th className="p-2">Репозиторий · аккаунт</th>
              <th className="p-2">Состояние</th>
              <th className="p-2">Обновлено</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((i) => (
              <Fragment key={`${i.repo}/${i.number}`}>
              <tr
                className={`border-b border-border ${selected?.repo === i.repo && selected.number === i.number ? "bg-muted" : ""}`}
              >
                <td className="p-2">
                  <button
                    className="text-left hover:underline"
                    onClick={() => setSelected(i)}
                  >
                    #{i.number} {i.title}
                  </button>
                  <p className="text-xs text-muted-foreground">
                    {i.author} · {i.labels.join(", ")}
                  </p>
                </td>
                <td className="p-2">
                  {i.repo}
                  <p className="text-xs text-muted-foreground">{i.account}</p>
                </td>
                <td className="p-2">{i.state}</td>
                <td className="p-2 whitespace-nowrap">
                  {new Date(i.updatedAt).toLocaleDateString()}
                </td>
              </tr>
              {selected?.repo === i.repo && selected.number === i.number && (
                <tr className="xl:hidden border-b border-border"><td colSpan={4} className="p-3">
                  <div className="rounded-lg border border-border bg-card p-3 space-y-3">
                    <div className="flex items-start justify-between gap-3"><strong className="text-sm">#{selected.number} {selected.title}</strong><button className="text-xs text-muted-foreground hover:underline" onClick={() => setSelected(null)}>Закрыть</button></div>
                    {!value && !readError && <p role="status">Загружаем #{selected.number} из {selected.repo}…</p>}
                    {readError && <p role="alert" className="text-destructive">{readError}</p>}
                    {value && <Content value={value} projectId={project.bbProjectId} />}
                  </div>
                </td></tr>
              )}
              </Fragment>
            ))}
          </tbody>
        </table>
          </div>
          {!loading && result && !filtered.length && (
        <p className="text-sm text-muted-foreground">
          {result.errors.length
            ? "Часть репозиториев недоступна; пустой список не означает отсутствие задач."
            : "Нет записей по выбранным фильтрам."}
        </p>
      )}
        </div>
        {selected && (
          <aside className="hidden xl:block min-w-0 rounded-lg border border-border bg-card p-3 space-y-3 xl:sticky xl:top-3">
            <div className="flex items-start justify-between gap-3">
              <strong className="text-sm">#{selected.number} {selected.title}</strong>
              <button className="text-xs text-muted-foreground hover:underline" onClick={() => setSelected(null)}>Закрыть</button>
            </div>
            {!value && !readError && <p role="status">Загружаем #{selected.number} из {selected.repo}…</p>}
            {readError && <p role="alert" className="text-destructive">{readError}</p>}
            {value && <Content value={value} projectId={project.bbProjectId} />}
          </aside>
        )}
      </div>
    </div>
  );
}
export function Dashboard({ subPath }: PluginNavPanelProps) {
  const context = useBbContext();
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof contract>();
  const [projects, setProjects] = useState<Project[]>([]),
    [accounts, setAccounts] = useState<string[]>([]),
    [selected, setSelected] = useState(""),
    [editor, setEditor] = useState<Project | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    rpc
      .call("catalog")
      .then(
        (r) => {
          if (!live) return;
          setProjects(r.projects);
          setAccounts(r.accounts);
          const parts = subPath.split("/");
          let routeId = "";
          try {
            routeId = decodeURIComponent(parts[0] ?? "");
          } catch {}
          const chosen =
            r.projects.find((p) => p.id === routeId) ??
            (!subPath
              ? r.projects.find(
                  (p) =>
                    p.bbProjectId === context.projectId &&
                    context.projectId !== null,
                )
              : undefined);
          setSelected(chosen?.id ?? "");
          setEditor(parts[1] === "settings" && chosen ? chosen : null);
          if (routeId === "new" && parts[1]) {
            let bbProjectId = "";
            try {
              bbProjectId = decodeURIComponent(parts[1]);
            } catch {}
            const linked = r.projects.find(
              (p) => p.bbProjectId === bbProjectId,
            );
            setEditor(
              linked ?? {
                id: crypto.randomUUID(),
                name: "Новый проект",
                bbProjectId,
                autopilotProject: null,
                repositories: [],
              },
            );
            setSelected(linked?.id ?? "");
          }
          setError(r.accountError ?? "");
        },
        (e) => {
          if (live) setError(String(e));
        },
      )
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [rpc, subPath, context.projectId]);
  const project = projects.find((p) => p.id === selected);
  return (
    <main className="p-5 space-y-5 max-w-7xl mx-auto w-full overflow-y-auto">
      <header>
        <h1 className="text-2xl font-semibold">GitHub · проекты</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Репозитории, PR и задачи проекта. Просмотр открывается ниже, без
          агентного треда.
        </p>
      </header>
      <div className="flex flex-wrap gap-2">
        <select
          aria-label="Проект"
          className={field}
          value={selected}
          onChange={(e) => {
            setSelected(e.target.value);
            navigate.toPluginPanel("projects", {
              subPath: encodeURIComponent(e.target.value),
            });
            setEditor(null);
          }}
        >
          <option value="">Выбери проект</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {p.repositories.length} репозиториев
            </option>
          ))}
        </select>
        <Button
          variant="outline"
          onClick={() =>
            setEditor({
              id: crypto.randomUUID(),
              name: "",
              bbProjectId: null,
              autopilotProject: null,
              repositories: [],
            })
          }
        >
          Добавить проект
        </Button>
        {project && (
          <Button
            variant="outline"
            onClick={() =>
              navigate.toPluginPanel("projects", {
                subPath: `${encodeURIComponent(project.id)}/settings`,
              })
            }
          >
            Репозитории и аккаунты
          </Button>
        )}
      </div>
      {loading && <p role="status">Загружаем проекты…</p>}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {editor && (
        <Editor
          key={editor.id}
          initial={editor}
          accounts={accounts}
          onCancel={() => {
            setEditor(null);
            navigate.toPluginPanel("projects", {
              subPath: project ? encodeURIComponent(project.id) : "",
            });
          }}
          onSave={async (p) => {
            const saved = await rpc.call("saveProject", p);
            setProjects((old) => [
              ...old.filter((x) => x.id !== saved.id),
              saved,
            ]);
            setSelected(saved.id);
            navigate.toPluginPanel("projects", {
              subPath: encodeURIComponent(saved.id),
            });
            setEditor(null);
          }}
        />
      )}
      {project && !editor ? (
        <ProjectView key={JSON.stringify(project)} project={project} />
      ) : (
        !loading && (
          <p className="text-muted-foreground">
            Выбери или добавь проект. Аккаунт выбирается отдельно для каждого
            репозитория.
          </p>
        )
      )}
    </main>
  );
}
export function ProjectSettingsShortcut({
  projectId,
}: PluginHomepageSectionProps) {
  const rpc = useRpc<typeof contract>();
  const navigate = useBbNavigate();
  const [state, setState] = useState<{
    projectId: string;
    projects: Project[];
  } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setState(null);
    setError("");
    if (projectId)
      rpc.call("catalog").then(
        (r) => {
          if (live) setState({ projectId, projects: r.projects });
        },
        (e) => {
          if (live) setError(String(e));
        },
      );
    return () => {
      live = false;
    };
  }, [rpc, projectId]);
  if (!projectId) return null;
  const loaded = state?.projectId === projectId;
  const linked = loaded
    ? state.projects.filter((p) => p.bbProjectId === projectId)
    : [];
  return (
    <div className="space-y-2">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {linked.length ? (
        linked.map((p) => (
          <Button
            key={p.id}
            variant="outline"
            onClick={() =>
              navigate.toPluginPanel("projects", {
                subPath: `${encodeURIComponent(p.id)}/settings`,
              })
            }
          >
            Репозитории и аккаунты GitHub
            {linked.length > 1 ? ` · ${p.name}` : ""}
          </Button>
        ))
      ) : (
        <Button
          variant="outline"
          disabled={!loaded}
          onClick={() =>
            navigate.toPluginPanel("projects", {
              subPath: `new/${encodeURIComponent(projectId)}`,
            })
          }
        >
          {loaded
            ? "Настроить GitHub для проекта"
            : "Загружаем настройки GitHub…"}
        </Button>
      )}
    </div>
  );
}
export default definePluginApp((app) => {
  app.slots.homepageSection({
    id: "github-project-settings",
    title: "GitHub проекта",
    component: ProjectSettingsShortcut,
  });
  app.slots.navPanel({
    id: "projects",
    path: "projects",
    title: "GitHub · проекты",
    icon: "Github",
    component: Dashboard,
  });
});
