import {AccountEmailForm} from './account-email-form';
import { AccountSettingsStyle } from './account-settings-style';
import type { AccountProjects } from "./src/contracts.js";
import { AccountProjectsForm } from "./account-projects-form";
import { AccountPolicyForm } from "./account-policy-form";
import { policySummary, policyThresholds, reserveHours, scheduleAllows } from "./src/account-policy.js";
import type { AccountPolicy } from "./src/contracts.js";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { Button } from "./ui/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/components/ui/collapsible";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/components/ui/dropdown-menu";
import { Icon } from "./ui/components/ui/icon";
import { Input } from "./ui/components/ui/input";
import { cn } from "./ui/lib/utils";
import { ResourceRowDetailChevron } from "./ui/components/ui/resource/row";
import { Switch } from "./ui/components/ui/switch";
import type {
  AccountSummary,
  AccountPoolConfig,
  AccountPoolConfigSetInput,
  FamilyQuota,
  LimitWindow,
  ModelFamily,
  PoolProvider,
  PoolStatus,
} from "./src/contracts.js";
import type { ThreadAccountStatus, accountPoolRpcContract } from "./src/rpc.js";
import type { OAuthLoginStart } from "./src/oauth-login.js";
import type { CodexDeviceLoginStart } from "./src/codex-device-login.js";
import type { GrokDeviceLoginStart } from "./src/grok-device-login.js";
import {
  DEFAULT_ACCOUNT_POOL_CONFIG,
  modelFamilySchema,
  statusSchema,
} from "./src/contracts.js";
import { blockingResetAt } from "./src/quota.js";
import { DEFAULT_RESERVE_CAP } from "./src/balancer.js";
import {
  ACCOUNT_POOL_ACCOUNTS_CHANGED,
  ACCOUNT_POOL_CONFIG_CHANGED,
} from "./src/realtime.js";

type DialogState =
  | {
      kind: "account" | "priority" | "role" | "cap" | "remove";
      accountId: string;
    }
  | { kind: "claude-login" | "codex-login" | "agy-login" | "grok-login" }
  | { kind: "api-key"; provider: PoolProvider }
  | null;

type ConfigField = Exclude<
  keyof AccountPoolConfig,
  "claudeRequestStartIntervalMs" | "routingStrategy" | "reserveDrainHours" | "restDays" | "vpnOnlyProviders" | "vpnStatusFile" | "browserHostId" | "vpnGuardEnabled" | "vpnPolicyVersion"
>;

const PROVIDERS: Array<{
  id: PoolProvider;
  title: string;
  description: string;
}> = [
  {
    id: "claude",
    title: "Claude",
    description: "Claude Code threads on all machines use these accounts.",
  },
  {
    id: "codex",
    title: "Codex",
    description: "Codex threads use these ChatGPT accounts.",
  },
  {
    id: "kimi",
    title: "Kimi For Coding",
    description:
      "opencode threads using a Kimi subscription use these keys; only the hub token remains on the machine.",
  },
  {
    id: "zai",
    title: "Z.ai Coding Plan",
    description:
      "opencode threads using a z.ai subscription use these keys; only the hub token remains on the machine.",
  },
  {
    id: "agy",
    title: "Antigravity",
    description: "Google sign-in is stored on the Pool server; client machines receive only a scoped Pool token.",
  },
  {
    id: "neuraldeep",
    title: "NeuralDeep",
    description: "The key is stored on the Pool server; client machines receive only a scoped Pool token.",
  },
  {
    id: "opencode-go",
    title: "OpenCode Go",
    description:
      "opencode threads using a Go subscription use these keys; only the hub token remains on the machine.",
  },
  {
    id: "cursor",
    title: "Cursor",
    description:
      "Cursor threads use this key; the machine receives a hub token instead of the subscription key.",
  },
  {
    id: "devin",
    title: "Devin",
    description: "Devin CLI uses account PATs through the pool; only the hub token remains on the client.",
  },
  {
    id: "grok",
    title: "Grok",
    description:
      "Grok Code subscriptions are stored on the Pool server; ACP sessions receive only a scoped Pool token.",
  },
];
const FAMILY_LABELS: Record<ModelFamily, string> = {
  fable: "Fable, weekly",
  sonnet: "Sonnet, weekly",
  opus: "Opus, weekly",
  haiku: "Haiku, weekly",
  other: "Other, weekly",
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function httpUrlError(value: string): string | null {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:"
      ? null
      : "Enter an HTTP or HTTPS URL.";
  } catch {
    return "Enter a valid URL.";
  }
}

function configDrafts(config: AccountPoolConfig): Record<ConfigField, string> {
  return {
    anthropicUpstreamBaseUrl: config.anthropicUpstreamBaseUrl,
    codexUpstreamBaseUrl: config.codexUpstreamBaseUrl,
    kimiUpstreamBaseUrl: config.kimiUpstreamBaseUrl,
    zaiUpstreamBaseUrl: config.zaiUpstreamBaseUrl,
    opencodeGoUpstreamBaseUrl: config.opencodeGoUpstreamBaseUrl,
    neuraldeepUpstreamBaseUrl: config.neuraldeepUpstreamBaseUrl,
    cursorUpstreamBaseUrl: config.cursorUpstreamBaseUrl,
    devinUpstreamBaseUrl: config.devinUpstreamBaseUrl,
    maxConcurrentRequestsPerAccount: String(config.maxConcurrentRequestsPerAccount),
    grokUpstreamBaseUrl: config.grokUpstreamBaseUrl,
    switchThreshold: String(config.switchThreshold),
  };
}
function percent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function daysOffSummary(restDays: readonly number[]): string {
  if (restDays.length === 0) return "Every day counts toward the reset.";
  const names = [...restDays]
    .sort((left, right) => left - right)
    .map((day) => WEEKDAY_LABELS[day] ?? String(day));
  return `${names.join(", ")} do not count toward the reset.`;
}

const POOL_TIME_ZONE = "Europe/Moscow";

function moment(timestamp: number): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: POOL_TIME_ZONE,
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(timestamp);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("day")}.${part("month")} ${part("hour")}:${part("minute")} (${part("weekday")})`;
}

function accountFullName(account: AccountSummary): string {
  return account.email?.trim() || "No email set";
}
function relative(timestamp: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - timestamp) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} hr ago` : `${Math.round(hours / 24)} days ago`;
}
function windowShortLabel(
  window: LimitWindow,
  provider: PoolProvider = "codex",
): string {
  if (window.windowMinutes === null) {
    if (provider === "codex") return window.slot === "primary" ? "5H" : "7D";
    return window.slot === "primary" ? "LIMIT" : "LIMIT 2";
  }
  if (window.windowMinutes % 1_440 === 0)
    return `${window.windowMinutes / 1_440}D`;
  if (window.windowMinutes % 60 === 0) return `${window.windowMinutes / 60}H`;
  return `${window.windowMinutes}M`;
}
function windowLongLabel(
  window: LimitWindow,
  provider: PoolProvider = "codex",
): string {
  if (window.windowMinutes === null) {
    if (provider === "codex")
      return window.slot === "primary" ? "5 hours" : "Weekly";
    return window.slot === "primary" ? "Limit" : "Second limit";
  }
  if (window.windowMinutes === 7 * 24 * 60) return "Weekly";
  if (window.windowMinutes % 1_440 === 0)
    return `${window.windowMinutes / 1_440} days`;
  if (window.windowMinutes % 60 === 0) return `${window.windowMinutes / 60} hr`;
  return `${window.windowMinutes} min`;
}
function resetLabel(timestamp: number | null): string {
  if (timestamp === null) return "";
  const exact = `${new Intl.DateTimeFormat("en-GB", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: POOL_TIME_ZONE,
  }).format(timestamp)} UTC+3`;
  const remaining = timestamp - Date.now();
  if (remaining <= 0) return "Reset time has passed · refresh quotas";
  const minutes = Math.max(1, Math.round(remaining / 60_000));
  if (minutes < 1_440)
    return `automatic reset ${exact} (in ${minutes >= 60 ? `${Math.floor(minutes / 60)} hr ${minutes % 60} min` : `${minutes} min`})`;
  return `automatic reset ${exact}`;
}
const STATUS_CACHE_KEY = "account-pool:status";

function savedResetDeadline(timestamp: number | null): string {
  if (timestamp === null) return "expiration unknown";
  const date = new Intl.DateTimeFormat("en-GB", {
    day: "numeric", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23", timeZone: POOL_TIME_ZONE,
  }).format(timestamp);
  return `${timestamp <= Date.now() ? "expired" : "expires"} ${date} UTC+3`;
}

function resetLimitLabel(limit: string): string {
  const labels: Record<string, string> = {
    five_hour: "5 hours", seven_day: "weekly limit",
    seven_day_fable: "Fable · weekly", seven_day_opus: "Opus · weekly",
    seven_day_sonnet: "Sonnet · weekly", seven_day_haiku: "Haiku · weekly",
  };
  return labels[limit] ?? limit;
}

function readCachedStatus(): PoolStatus | null {
  try {
    const raw = window.localStorage.getItem(STATUS_CACHE_KEY);
    if (raw === null) return null;
    const parsed = statusSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function writeCachedStatus(status: PoolStatus): void {
  try {
    window.localStorage.setItem(STATUS_CACHE_KEY, JSON.stringify(status));
  } catch {
    return;
  }
}

function weeklyResetAt(account: AccountSummary): number | null {
  if (account.provider === "claude") return account.sevenDayResetAt;
  return longestCodexWindow(account)?.resetAt ?? null;
}

function longestCodexWindow(account: AccountSummary): LimitWindow | null {
  let longest: LimitWindow | null = null;
  for (const window of account.limitWindows) {
    if (
      longest === null ||
      (window.windowMinutes ?? 0) > (longest.windowMinutes ?? 0)
    )
      longest = window;
  }
  return longest;
}

function statusPresentation(
  account: AccountSummary,
  threshold: number,
): {
  label: string;
  dot: string;
} {
  if (account.drainOnce) threshold = 1;
  if (account.enabled && !account.drainOnce && !scheduleAllows(account.policy, Date.now())) return { label: "Outside schedule", dot: "bg-muted-foreground" };
  if (account.status === "ready" && account.capReached) {
    const resetAt = weeklyResetAt(account);
    return {
      label: `Cap${resetAt === null ? "" : ` · ${resetLabel(resetAt)}`}`,
      dot: "bg-warning",
    };
  }
  if (account.status === "ready" && !account.eligible)
    return {
      label:
        account.role === "reserve" ? "Reserve · standby" : "Not selected",
      dot: "bg-muted-foreground",
    };
  if (account.status === "held")
    return {
      label: `Paused${account.heldUntil === null ? "" : ` · retry at ${new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", timeZone: POOL_TIME_ZONE }).format(account.heldUntil)}`}`,
      dot: "bg-warning",
    };
  if (account.status === "exhausted") {
    const resetAt = blockingResetAt(account, null, policyThresholds(account, threshold), Date.now());
    return {
      label: `Exhausted${resetAt === null ? "" : ` · ${resetLabel(resetAt)}`}`,
      dot: "bg-destructive",
    };
  }
  if (account.status === "error")
    return { label: account.error?.includes("[OAUTH_REAUTH_REQUIRED]") ? "Reauthentication required" : "Error", dot: "bg-destructive" };
  if (account.status === "disabled")
    return { label: "Disabled", dot: "bg-muted-foreground" };
  return { label: "Active", dot: "bg-success" };
}
function tier(account: AccountSummary): string {
  return (
    account.subscriptionType ??
    (account.kind === "api-key" ? "API key" : "OAuth")
  );
}
function SettingsBadge({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded-sm border border-border bg-muted/40 px-1.5 py-0.5 text-2xs leading-none text-subtle-foreground">
      {children}
    </span>
  );
}

function SettingsSection({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description: string;
  action: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <p className="mt-0.5 text-xs leading-snug text-subtle-foreground/75">
            {description}
          </p>
        </div>
        <div className="shrink-0 self-start">{action}</div>
      </div>
      <div className="border-t border-border">{children}</div>
    </section>
  );
}

type QuotaSlot = {
  key: string;
  label: string;
  utilization: number | null;
  status: string | null;
  limit: number;
};

function quotaSlots(account: AccountSummary, threshold: number): QuotaSlot[] {
  if (account.drainOnce) threshold = 1;
  const limits = policyThresholds(account, threshold);
  const weeklyLimit = Math.min(limits.weekly, account.capLimit ?? limits.weekly);
  if (account.provider === "codex") {
    if (account.limitWindows.length === 0)
      return [
        {
          key: "primary",
          label: "5H",
          utilization: null,
          status: null,
          limit: limits.fiveHour,
        },
      ];
    return account.limitWindows.map((window) => ({
      key: window.slot,
      label: windowShortLabel(window, account.provider),
      utilization: window.utilization,
      status: window.status,
      limit:
        (window.windowMinutes ?? (window.slot === "primary" ? 300 : 10_080)) >=
        1_440
          ? weeklyLimit
          : window.windowMinutes === 300 ? limits.fiveHour : limits.other,
    }));
  }
  return [
    {
      key: "five-hour",
      label: "5H",
      utilization: account.fiveHourUtilization,
      status: account.fiveHourStatus,
      limit: limits.fiveHour,
    },
    {
      key: "seven-day",
      label: "7D",
      utilization: account.sevenDayUtilization,
      status: account.sevenDayStatus,
      limit: weeklyLimit,
    },
    {
      key: "fable",
      label: "FABLE",
      utilization: account.familyWeekly.fable?.utilization ?? null,
      status: account.familyWeekly.fable?.status ?? null,
      limit: weeklyLimit,
    },
  ];
}

function quotaToneClass(slot: QuotaSlot): string {
  if (
    slot.status?.toLowerCase() === "rejected" ||
    (slot.utilization !== null && slot.utilization >= slot.limit)
  )
    return "text-destructive-text";
  if (slot.utilization !== null && slot.utilization >= slot.limit - 0.1)
    return "text-warning-text";
  return slot.utilization === null
    ? "text-subtle-foreground/75"
    : "text-foreground";
}

function QuotaValue({
  slot,
  threshold,
  refreshing,
}: {
  slot: QuotaSlot;
  threshold: number;
  refreshing: boolean;
}) {
  return (
    <div
      className={cn(
        "w-16 text-left tabular-nums transition-opacity sm:text-right",
        refreshing && "opacity-50",
      )}
    >
      <div className="text-2xs uppercase tracking-wide text-subtle-foreground/75">
        {slot.label}
      </div>
      <div className={cn("text-xs font-semibold", quotaToneClass(slot))}>
        {percent(slot.utilization)}
      </div>
    </div>
  );
}

const restrictAccountDragToVerticalAxis: Modifier = ({ transform }) => ({
  ...transform,
  x: 0,
});
const accountDragModifiers: Modifier[] = [restrictAccountDragToVerticalAxis];

type AccountAction =
  | "browser"
  | "toggle"
  | "drain"
  | "priority"
  | "role"
  | "cap"
  | "refresh"
  | "remove";

function capText(account: AccountSummary): string | null {
  if (account.capLimit === null) return null;
  const curve =
    account.cap ?? (account.role === "reserve" ? DEFAULT_RESERVE_CAP : null);
  return curve === null
    ? `current cap ${percent(account.capLimit)}`
    : `current cap ${percent(account.capLimit)} (${percent(curve.early)}→${percent(curve.late)})`;
}

function AccountRow({
  account,
  threshold,
  current,
  pending,
  refreshing,
  onAction,
  onOpen,
  reorderDisabled,
}: {
  account: AccountSummary;
  threshold: number;
  current: boolean;
  pending: boolean;
  refreshing: boolean;
  onAction: (action: AccountAction) => void;
  onOpen: () => void;
  reorderDisabled: boolean;
}) {
  const cap = capText(account);
  const status = statusPresentation(account, threshold);
  const slots = quotaSlots(account, threshold);
  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: account.id, disabled: pending || reorderDisabled });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "flex items-center gap-3 text-sm",
        isDragging && "relative z-10 rounded-md bg-card opacity-90 shadow-lift",
      )}
    >
      <Button
        ref={setActivatorNodeRef}
        type="button"
        variant="ghost"
        size="icon"
        className="size-8 shrink-0 touch-none text-muted-foreground enabled:cursor-grab enabled:active:cursor-grabbing"
        disabled={pending || reorderDisabled}
        aria-label={`Move ${accountFullName(account)}`}
        {...attributes}
        {...listeners}
      >
        <Icon name="DragDropVertical" aria-hidden="true" />
      </Button>
      <div
        className={cn(
          "group -mx-2 flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2.5 transition-colors hover:bg-state-hover focus-within:bg-state-hover",
          !account.enabled && "opacity-55",
        )}
      >
        <button
          type="button"
          className="grid min-w-0 flex-1 grid-cols-1 items-center gap-y-1.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-y-0"
          aria-label={`Open ${accountFullName(account)}`}
          onClick={onOpen}
        >
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-sm font-medium text-foreground">
                {accountFullName(account)}
              </span>
              <SettingsBadge>{tier(account)}</SettingsBadge>
              {account.drainOnce ? <SettingsBadge>Until exhausted</SettingsBadge> : null}
              {account.policy?.enabled ? <SettingsBadge>Custom settings</SettingsBadge> : null}
              {account.projects?.rules.length ? <SettingsBadge>{account.projects.onlySelected ? "Selected projects only" : "Project roles"} · {account.projects.rules.length}</SettingsBadge> : null}
              {account.role === "reserve" ? (
                <SettingsBadge>Reserve</SettingsBadge>
              ) : null}
              {current ? <SettingsBadge>Current</SettingsBadge> : null}
            </div>
            {account.policy?.enabled && <p className="text-xs text-muted-foreground">{policySummary(account.policy)}</p>}
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-subtle-foreground/75">
              <span className="inline-flex shrink-0 items-center gap-1.5">
                <span className={cn("size-1.5 rounded-full", status.dot)} />
                {status.label}
              </span>
              {account.lastUsedAt === null ? null : (
                <span>last used {relative(account.lastUsedAt)}</span>
              )}
              {cap === null ? null : <span>{cap}</span>}
              {refreshing ? <span>refreshing quotas…</span> : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 sm:flex-nowrap sm:gap-1">
            {slots.map((slot) => (
              <QuotaValue
                key={slot.key}
                slot={slot}
                threshold={threshold}
                refreshing={refreshing}
              />
            ))}
          </div>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 data-[state=open]:bg-state-active"
              aria-label={`Actions: ${accountFullName(account)}`}
            >
              <Icon name="MoreHorizontal" className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem disabled={pending} onSelect={() => onAction("browser")}>
              <Icon name="ExternalLink" />
              Open in browser
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={pending}
              onSelect={() => onAction("toggle")}
            >
              <Icon name={account.enabled ? "Circle" : "CircleCheck"} />
              {account.enabled ? "Disable" : "Enable"}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={pending}
              onSelect={() => onAction("priority")}
            >
              <Icon name="ListView" />
              Set priority…
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={pending}
              onSelect={() => onAction("role")}
            >
              <Icon name="ListView" />
              Set role…
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={pending}
              onSelect={() => onAction("cap")}
            >
              <Icon name="ListView" />
              Set weekly cap…
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={pending}
              onSelect={() => onAction("refresh")}
            >
              <Icon name="RotateCcw" />
              Refresh quotas
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={pending}
              onSelect={() => onAction("remove")}
            >
              <Icon name="Trash2" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          aria-label={`Open account card: ${accountFullName(account)}`}
          onClick={onOpen}
        >
          <ResourceRowDetailChevron />
        </button>
      </div>
    </div>
  );
}

function AddAccountMenu({
  provider,
  onChoose,
}: {
  provider: PoolProvider;
  onChoose: (choice: "login" | "import" | "api-key") => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline">
          <Icon name="Plus" className="size-3.5" />
          Add account
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {(provider === "claude" || provider === "codex" || provider === "agy" || provider === "grok") ? <DropdownMenuItem
          className="items-start py-2"
          onSelect={() => onChoose("login")}
        >
          <Icon name="UserRound" className="mt-0.5" />
          <span>
            <span className="block">
              Sign in to {provider === "claude" ? "Claude" : provider === "agy" ? "Antigravity" : provider === "grok" ? "Grok" : "Codex"}
            </span>
            <span className="block text-xs text-muted-foreground">
              {provider === "claude"
                ? "Opens claude.ai; paste the code back here"
                : provider === "agy"
                  ? "Sign in to Google; paste the code back here"
                  : "Opens ChatGPT with a device code"}
            </span>
          </span>
        </DropdownMenuItem> : null}
        {(provider === "claude" || provider === "codex") ? <DropdownMenuItem
          className="items-start py-2"
          onSelect={() => onChoose("import")}
        >
          <Icon name="Download" className="mt-0.5" />
          <span>
            <span className="block">Import from this machine</span>
            <span className="block text-xs text-muted-foreground">
              Copies the {provider === "claude" ? "~/.claude" : "Codex"} login from
              the server host
            </span>
          </span>
        </DropdownMenuItem> : null}
        {provider !== "codex" && provider !== "agy" ? (
          <>
            {provider === "claude" ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              className="items-start py-2"
              onSelect={() => onChoose("api-key")}
            >
              <Icon name="Lock" className="mt-0.5" />
              <span>
                <span className="block">{provider === "devin" ? "Add PAT…" : "Add API key…"}</span>
                <span className="block text-xs text-muted-foreground">
                  {provider === "claude" ? "Paid fallback, selected last" : provider === "grok" ? "For xAI API billing; stored on the Pool server" : "Key is stored on the Pool server"}
                </span>
              </span>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StepIndicator({ step }: { step: 1 | 2 | 3 }) {
  return (
    <div className="flex gap-1.5" aria-label={`Step ${step} of 3`}>
      {[1, 2, 3].map((value) => (
        <span
          key={value}
          className={cn(
            "h-1 flex-1 rounded-full",
            value <= step ? "bg-primary" : "bg-muted",
          )}
        />
      ))}
    </div>
  );
}
function QuotaDetail({
  label,
  quota,
  threshold,
  skipAt,
}: {
  label: string;
  quota: FamilyQuota | null;
  threshold: number;
  skipAt?: number;
}) {
  const utilization = quota?.utilization ?? null;
  const limit = skipAt ?? threshold;
  return (
    <div className="grid grid-cols-[7rem_1fr] items-center gap-3 text-sm">
      <div className="text-muted-foreground">{label}</div>
      <div className="min-w-0">
        <div className="mb-1 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full",
              utilization !== null && utilization >= limit
                ? "bg-destructive"
                : utilization !== null && utilization >= limit - 0.1
                  ? "bg-warning"
                  : "bg-primary",
            )}
            style={{
              width: `${Math.min(100, Math.max(0, (utilization ?? 0) * 100))}%`,
            }}
          />
        </div>
        <div className="text-xs text-muted-foreground">
          {percent(utilization)}
          {quota?.resetAt === null || quota === null
            ? " · reset time unknown"
            : ` · ${resetLabel(quota.resetAt)}`}{" "}
          · skip at {Math.round(limit * 100)}%
        </div>
      </div>
    </div>
  );
}

type CopyState = "idle" | "copied" | "manual";

function useCopyToClipboard(text: string, selectFallback: () => void) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );
  useEffect(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    setCopyState("idle");
  }, [text]);

  const copy = useCallback(() => {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopyState("copied");
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopyState("idle"), 1500);
      },
      () => {
        selectFallback();
        setCopyState("manual");
      },
    );
  }, [text, selectFallback]);

  return { copyState, copy };
}

function UserCodeBlock({ userCode, provider }: { userCode: string; provider: "Codex" | "Grok" }) {
  const codeRef = useRef<HTMLSpanElement>(null);
  const selectCode = useCallback(() => {
    const element = codeRef.current;
    if (element === null) return;
    const selection = window.getSelection();
    if (selection === null) return;
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
  }, []);
  const { copyState, copy } = useCopyToClipboard(userCode, selectCode);

  return (
    <div className="rounded-lg border border-border bg-surface-recessed px-4 py-4">
      <div className="grid grid-cols-[1fr_auto_1fr] items-center">
        <span
          ref={codeRef}
          className="col-start-2 select-all text-center font-mono text-2xl font-semibold tracking-widest"
          aria-label={`${provider} device code`}
        >
          {userCode}
        </span>
        <Button
          type="button"
          variant="ghost"
          aria-label={`Copy ${provider} sign-in code`}
          className="col-start-3 size-11 justify-self-start text-muted-foreground hover:text-foreground sm:size-9"
          onClick={copy}
        >
          <Icon name={copyState === "copied" ? "Check" : "Copy"} />
        </Button>
      </div>
      <span aria-live="polite" className="sr-only">
        {copyState === "copied"
          ? "Sign-in code copied"
          : copyState === "manual"
            ? "The browser blocked copying. The code is selected; copy it manually."
            : ""}
      </span>
    </div>
  );
}

function AuthorizationUrlRow({
  name,
  url,
  openUrl,
}: {
  name: string;
  url: string;
  openUrl: (url: string) => boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const selectUrl = useCallback(() => {
    inputRef.current?.select();
  }, []);
  const { copyState, copy } = useCopyToClipboard(url, selectUrl);

  return (
    <div>
      <div className="flex gap-2">
        <Input
          ref={inputRef}
          readOnly
          value={url}
          aria-label={`${name} authorization URL`}
        />
        <Button
          variant="outline"
          className="shrink-0"
          aria-label={`Copy ${name} authorization URL`}
          onClick={copy}
        >
          {copyState === "copied" ? "Copied" : "Copy"}
        </Button>
        <Button className="shrink-0" onClick={() => openUrl(url)}>
          Open
        </Button>
      </div>
      <span aria-live="polite" className="sr-only">
        {copyState === "copied"
          ? "Authorization URL copied"
          : copyState === "manual"
            ? "The browser blocked copying. The URL is selected; copy it manually."
            : ""}
      </span>
    </div>
  );
}

function DialogFrame({
  title,
  children,
  footer,
  className,
}: {
  title: string;
  children: ReactNode;
  footer: ReactNode;
  className?: string;
}) {
  return (
    <DialogContent
      hideCloseButton
      className={cn(
        "max-h-[85vh] grid-rows-[auto_minmax(0,1fr)_auto]",
        className,
      )}
    >
      <DialogHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <DialogTitle>{title}</DialogTitle>
        <DialogClose aria-label="Close" className="-mr-1 shrink-0 cursor-pointer rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2">
          <Icon name="X" className="size-4" />
          <span className="sr-only">Close</span>
        </DialogClose>
      </DialogHeader>
      <div className="min-h-0 space-y-5 overflow-y-auto">{children}</div>
      {footer === null ? null : (
        <DialogFooter className="pool-settings-footer flex-row items-center gap-2 sm:space-x-0">
          {footer}
        </DialogFooter>
      )}
    </DialogContent>
  );
}

function ConfigFieldRow({
  label,
  description,
  error,
  children,
}: {
  label: string;
  description: string;
  error: string | null;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <div className="text-sm text-foreground">{label}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {description}
        </div>
      </div>
      <div className="w-80 max-w-[50%] shrink-0">
        {children}
        {error === null ? null : (
          <p className="mt-1 text-xs text-destructive-text" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function AccountPoolSettings() {
  const rpc = useRpc<typeof accountPoolRpcContract>();
  const navigate = useBbNavigate();
  const [status, setStatus] = useState<PoolStatus | null>(readCachedStatus);
  const [statusIsCached, setStatusIsCached] = useState(status !== null);
  const [config, setConfig] = useState<AccountPoolConfig | null>(null);
  const [drafts, setDrafts] = useState<Record<ConfigField, string>>({
    anthropicUpstreamBaseUrl: "",
    codexUpstreamBaseUrl: "",
    kimiUpstreamBaseUrl: "",
    zaiUpstreamBaseUrl: "",
    opencodeGoUpstreamBaseUrl: "",
    neuraldeepUpstreamBaseUrl: "",
    cursorUpstreamBaseUrl: "",
    devinUpstreamBaseUrl: "",
    maxConcurrentRequestsPerAccount: "",
    grokUpstreamBaseUrl: "",
    switchThreshold: "",
  });
  const [configErrors, setConfigErrors] = useState<
    Record<ConfigField, string | null>
  >({
    anthropicUpstreamBaseUrl: null,
    codexUpstreamBaseUrl: null,
    kimiUpstreamBaseUrl: null,
    zaiUpstreamBaseUrl: null,
    opencodeGoUpstreamBaseUrl: null,
    neuraldeepUpstreamBaseUrl: null,
    cursorUpstreamBaseUrl: null,
    devinUpstreamBaseUrl: null,
    maxConcurrentRequestsPerAccount: null,
    grokUpstreamBaseUrl: null,
    switchThreshold: null,
  });
  const [dialog, setDialog] = useState<DialogState>(null);
  const [policyUnsaved, setPolicyUnsaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const browserBusy = useRef(false);
  const [browserNotice, setBrowserNotice] = useState<{ accountId: string; text: string } | null>(null);
  const [browserError, setBrowserError] = useState<{ accountId: string; text: string } | null>(null);
  const [optimisticOrder, setOptimisticOrder] = useState<{
    provider: PoolProvider;
    ids: string[];
  } | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const [loginStep, setLoginStep] = useState<OAuthLoginStart | null>(null);
  const [codexStep, setCodexStep] = useState<CodexDeviceLoginStart | null>(
    null,
  );
  const [grokStep, setGrokStep] = useState<GrokDeviceLoginStart | null>(null);
  const [agyStep,setAgyStep]=useState<{sessionId:string;authorizeUrl:string;expiresAt:number}|null>(null);
  const [loginDone, setLoginDone] = useState<string | null>(null);
  const [reauthorizeAccountId, setReauthorizeAccountId] = useState<string | null>(null);
  const [pastedCode, setPastedCode] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [priority, setPriority] = useState("100");
  const [roleDraft, setRoleDraft] = useState<AccountSummary["role"]>("primary");
  const [capDraft, setCapDraft] = useState({ early: "", late: "" });
  const [drainDraft, setDrainDraft] = useState("");
  const [routingError, setRoutingError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(0);
  const mounted = useRef(true);
  const threshold =
    config?.switchThreshold ?? DEFAULT_ACCOUNT_POOL_CONFIG.switchThreshold;
  const applyConfig = useCallback((next: AccountPoolConfig) => {
    setConfig(next);
    setDrafts(configDrafts(next));
    setDrainDraft(String(next.reserveDrainHours));
  }, []);
  const refresh = useCallback(async () => {
    try {
      const next = await rpc.call("status.get", null);
      writeCachedStatus(next);
      if (!mounted.current) return;
      setStatus(next);
      setStatusIsCached(false);
    } catch (loadError) {
      if (mounted.current) setError(errorText(loadError));
    }
  }, [rpc]);
  const refreshConfig = useCallback(async () => {
    try {
      const next = await rpc.call("config.get", null);
      if (mounted.current) applyConfig(next);
    } catch (loadError) {
      if (mounted.current) setError(errorText(loadError));
    }
  }, [applyConfig, rpc]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    void refreshConfig();
    return () => {
      mounted.current = false;
    };
  }, [refresh, refreshConfig]);
  useRealtime(ACCOUNT_POOL_ACCOUNTS_CHANGED, () => {
    void refresh();
  });
  useEffect(() => {
    if (dialog?.kind !== "account") return;
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [dialog?.kind, refresh]);
  useRealtime(ACCOUNT_POOL_CONFIG_CHANGED, () => {
    void refreshConfig();
  });
  useEffect(() => {
    if (codexStep === null || loginDone !== null) return;
    const update = () =>
      setCountdown(
        Math.max(0, Math.ceil((codexStep.expiresAt - Date.now()) / 1_000)),
      );
    update();
    const interval = window.setInterval(update, 1_000);
    return () => window.clearInterval(interval);
  }, [codexStep, loginDone]);
  useEffect(() => {
    if (codexStep === null || loginDone !== null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const result = await rpc.call("codexLogin.poll", {
          sessionId: codexStep.sessionId,
        });
        if (cancelled) return;
        if (result.status === "complete") {
          setLoginDone(result.account.label);
          setCodexStep(null);
          await refresh();
        } else if (result.status === "error") {
          setCodexStep(null);
          setError(result.message);
        } else timer = setTimeout(poll, codexStep.intervalMs);
      } catch (pollError) {
        if (!cancelled) setError(errorText(pollError));
      }
    };
    timer = setTimeout(poll, codexStep.intervalMs);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [codexStep, loginDone, refresh, rpc]);
  useEffect(() => {
    if (grokStep === null || loginDone !== null) return;
    const update = () =>
      setCountdown(Math.max(0, Math.ceil((grokStep.expiresAt - Date.now()) / 1_000)));
    update();
    const interval = window.setInterval(update, 1_000);
    return () => window.clearInterval(interval);
  }, [grokStep, loginDone]);
  useEffect(() => {
    if (grokStep === null || loginDone !== null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const result = await rpc.call("grokLogin.poll", { sessionId: grokStep.sessionId });
        if (cancelled) return;
        if (result.status === "complete") {
          setLoginDone(result.account.label);
          setGrokStep(null);
          await refresh();
        } else if (result.status === "error") {
          setGrokStep(null);
          setError(result.message);
        } else timer = setTimeout(poll, grokStep.intervalMs);
      } catch (pollError) {
        if (!cancelled) setError(errorText(pollError));
      }
    };
    timer = setTimeout(poll, grokStep.intervalMs);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [grokStep, loginDone, refresh, rpc]);
  const accounts = status?.accounts ?? [];
  const selectedAccount =
    dialog?.kind === "account" ||
    dialog?.kind === "priority" ||
    dialog?.kind === "role" ||
    dialog?.kind === "cap" ||
    dialog?.kind === "remove"
      ? (accounts.find((account) => account.id === dialog.accountId) ?? null)
      : null;
  async function run(key: string, action: () => Promise<void>): Promise<void> {
    if (pending !== null) return;
    setPending(key);
    setError(null);
    setBrowserError(null);
    try {
      await action();
      await refresh();
    } catch (actionError) {
      setError(errorText(actionError));
      await refresh().catch(()=>undefined);
    } finally {
      setPending(null);
    }
  }
  function updateConfigDraft(field: ConfigField, value: string): void {
    setDrafts((current) => ({ ...current, [field]: value }));
    setConfigErrors((current) => ({ ...current, [field]: null }));
  }
  async function saveConfigField(field: ConfigField): Promise<void> {
    if (config === null || pending !== null) return;
    let update: AccountPoolConfigSetInput;
    if (field === "maxConcurrentRequestsPerAccount") {
      const value = Number(drafts[field]);
      if (!Number.isInteger(value) || value < 1 || value > 32) {
        setConfigErrors(previous => ({...previous,[field]: "Enter a whole number from 1 to 32."}));
        return;
      }
      update = {maxConcurrentRequestsPerAccount:value};
    } else if (field === "switchThreshold") {
      const raw = drafts.switchThreshold.trim();
      const value = Number(raw);
      if (
        raw.length === 0 ||
        !Number.isFinite(value) ||
        value <= 0 ||
        value > 1
      ) {
        setConfigErrors((current) => ({
          ...current,
          switchThreshold: "Must be greater than 0 and no more than 1.",
        }));
        return;
      }
      if (value === config.switchThreshold) return;
      update = { switchThreshold: value };
    } else {
      const value = drafts[field].trim();
      const validationError = httpUrlError(value);
      if (validationError !== null) {
        setConfigErrors((current) => ({
          ...current,
          [field]: validationError,
        }));
        return;
      }
      if (value === config[field]) return;
      update =
        field === "anthropicUpstreamBaseUrl"
          ? { anthropicUpstreamBaseUrl: value }
          : { codexUpstreamBaseUrl: value };
    }
    setPending(`config-${field}`);
    setConfigErrors((current) => ({ ...current, [field]: null }));
    try {
      applyConfig(await rpc.call("config.set", update));
    } catch (saveError) {
      setConfigErrors((current) => ({
        ...current,
        [field]: errorText(saveError),
      }));
    } finally {
      setPending(null);
    }
  }
  async function startClaude(targetAccountId?: string): Promise<void> {
    setReauthorizeAccountId(targetAccountId??null);
    setLoginStep(null);
    setDialog({ kind: "claude-login" });
    setLoginDone(null);
    await run("claude-login", async () => {
      const started = targetAccountId ? await rpc.call("login.reauthorize",{accountId:targetAccountId}) : await rpc.call("login.start", null);
      setLoginStep(started);
      setPastedCode("");
    });
  }
  async function startCodex(): Promise<void> {
    setDialog({ kind: "codex-login" });
    setLoginDone(null);
    await run("codex-login", async () => {
      setCodexStep(await rpc.call("codexLogin.start", null));
    });
  }
  async function startGrok(): Promise<void> {
    if (grokStep !== null) void rpc.call("grokLogin.cancel", { sessionId: grokStep.sessionId }).catch(() => undefined);
    setGrokStep(null);
    setLoginDone(null);
    setDialog({ kind: "grok-login" });
    await run("grok-login", async () => {
      setGrokStep(await rpc.call("grokLogin.start", null));
    });
  }
  async function startAgy():Promise<void>{
    if(agyStep)void rpc.call('agyLogin.cancel',{sessionId:agyStep.sessionId}).catch(()=>undefined);
    setAgyStep(null);setPastedCode('');setLoginDone(null);setDialog({kind:'agy-login'});
    await run('agy-login',async()=>setAgyStep(await rpc.call('agyLogin.start',null)));
  }
  async function chooseAdd(
    provider: PoolProvider,
    choice: "login" | "import" | "api-key",
  ): Promise<void> {
    if (choice === "login") {
      if (provider === "agy") await startAgy();
      else if (provider === "grok") await startGrok();
      else if (provider === "claude") await startClaude();
      else await startCodex();
      return;
    }
    if (choice === "api-key") {
      setDialog({ kind: "api-key", provider });
      return;
    }
    await run(`import-${provider}`, async () => {
      await rpc.call("account.add", {
        provider,
        source: { kind: "import" },
        label: null,
        priority: 100,
      });
    });
  }
  async function saveRouting(update: AccountPoolConfigSetInput): Promise<void> {
    if (config === null || pending !== null) return;
    setPending("config-routing");
    setRoutingError(null);
    try {
      applyConfig(await rpc.call("config.set", update));
    } catch (saveError) {
      setRoutingError(errorText(saveError));
    } finally {
      setPending(null);
    }
  }
  async function saveDrainHours(): Promise<void> {
    if (config === null) return;
    const raw = drainDraft.trim();
    const value = Number(raw);
    if (raw === "" || !Number.isFinite(value) || value <= 0 || value > 168) {
      setRoutingError("Consumption hours must be greater than 0 and no more than 168.");
      return;
    }
    if (value === config.reserveDrainHours) return;
    await saveRouting({ reserveDrainHours: value });
  }
  async function accountAction(
    account: AccountSummary,
    action: AccountAction,
  ): Promise<void> {
    if (action === "browser") { await openBrowser(account.id); return; }
    if (policyUnsaved && ["priority", "role", "cap", "remove"].includes(action)) return;
    if (action === "priority") {
      setPriority(String(account.priority));
      setDialog({ kind: "priority", accountId: account.id });
      return;
    }
    if (action === "role") {
      setRoleDraft(account.role);
      setDialog({ kind: "role", accountId: account.id });
      return;
    }
    if (action === "cap") {
      const curve = account.cap ?? DEFAULT_RESERVE_CAP;
      setCapDraft({ early: String(curve.early), late: String(curve.late) });
      setDialog({ kind: "cap", accountId: account.id });
      return;
    }
    if (action === "remove") {
      setDialog({ kind: "remove", accountId: account.id });
      return;
    }
    await run(`${action}-${account.id}`, async () => {
      if (action === "toggle")
        await rpc.call(account.enabled ? "account.disable" : "account.enable", {
          id: account.id,
        });
      if (action === "drain")
        await rpc.call("account.setDrainOnce", { accountId: account.id, enabled: !account.drainOnce });
      if (action === "refresh")
        await rpc.call("account.refreshUsage", { accountId: account.id });
    });
  }
  async function openBrowser(accountId: string, url?: string): Promise<void> {
    if (pending !== null || browserBusy.current) return;
    browserBusy.current = true;
    setPending(`browser-${accountId}`);
    setError(null);
    setBrowserNotice(null);
    setBrowserError(null);
    try {
      await rpc.call("browser.open", { accountId, ...(url?.trim() ? { url: url.trim() } : {}) });
      if (mounted.current) setBrowserNotice({ accountId, text: "Browser opened on the Pooler machine." });
    } catch (launchError) {
      if (mounted.current) setBrowserError({ accountId, text: errorText(launchError) });
    } finally {
      browserBusy.current = false;
      if (mounted.current) setPending(null);
    }
  }
  async function reorderAccounts(
    provider: PoolProvider,
    event: DragEndEvent,
  ): Promise<void> {
    if (pending !== null || event.over === null) return;
    const ids = accounts
      .filter((account) => account.provider === provider)
      .map((account) => account.id);
    const from = ids.findIndex((id) => id === event.active.id);
    const to = ids.findIndex((id) => id === event.over?.id);
    if (from < 0 || to < 0 || from === to) return;
    const accountIds = arrayMove(ids, from, to);
    setOptimisticOrder({ provider, ids: accountIds });
    try {
      await run(`order-${provider}`, async () => {
        await rpc.call("account.reorder", { provider, accountIds });
      });
    } finally {
      setOptimisticOrder(null);
    }
  }
  function closeDialog(): void {
    if (dialog?.kind === "account" && policyUnsaved) return;
    if (dialog?.kind === "codex-login" && codexStep !== null)
      void rpc.call("codexLogin.cancel", { sessionId: codexStep.sessionId });
    if(dialog?.kind==="agy-login"&&agyStep)void rpc.call("agyLogin.cancel",{sessionId:agyStep.sessionId}).catch(()=>undefined);
    if (dialog?.kind === "grok-login" && grokStep !== null)
      void rpc.call("grokLogin.cancel", { sessionId: grokStep.sessionId }).catch(() => undefined);
    setAgyStep(null);setPastedCode("");
    if (dialog?.kind === "api-key") setApiKey("");
    setDialog(null);
    setBrowserError(null);
    setBrowserNotice(null);
    setLoginStep(null);
    setCodexStep(null);
    setGrokStep(null);
    setLoginDone(null);
    setError(null);
  }
  const hubHosts =
    status?.hosts.map((host) => host.hostName ?? host.hostId).join(", ") ||
    "no machines";
  const currentLabel = (provider: PoolProvider): string => {
    const id = status?.activeAccounts[provider] ?? null;
    const selected = accounts.find((account) => account.id === id);
    return selected ? accountFullName(selected) : "Not selected";
  };
  const currentId = (provider: PoolProvider): string | null =>
    status?.activeAccounts[provider] ?? null;
  const reserveAccounts = accounts
    .filter((account) => account.role === "reserve")
    .sort(
      (left, right) =>
        (left.drainOpensAt ?? Number.POSITIVE_INFINITY) -
        (right.drainOpensAt ?? Number.POSITIVE_INFINITY),
    );
  return (
    <div className="w-full space-y-6">
      <p className="text-xs text-subtle-foreground/75">
        Hub {status?.accepting ? "accepting requests" : "not accepting requests"} ·{" "}
        {status?.inFlight ?? 0} in flight · used by {hubHosts}
        {statusIsCached ? " · refreshing…" : null}
        {status?.vpn?.blockedProviders.length ? " · protected providers blocked by network policy" : null}
      </p>
      <div className="space-y-2">
      <label className="flex min-h-9 items-center gap-2 text-sm">
        <input type="checkbox" className="h-4 w-4 shrink-0" checked={config?.vpnGuardEnabled??false} disabled={config===null||pending!==null} onChange={e=>void saveRouting({vpnGuardEnabled:e.target.checked})}/>
        Follow VPN Guard
      </label>
      <p className="text-xs text-subtle-foreground">Blocks pool network calls to Codex, Claude, Cursor, and Devin when directed by Guard. If Guard is unavailable, requests fail before sending. Kimi and Z.ai are unaffected.</p>
      <p className="text-xs text-muted-foreground">Enable after updating VPN Guard. The old /1 endpoint will be rejected. Protected pool requests use IPv4; Kimi and Z.ai keep their normal transport.</p>
      </div>
      <section aria-label="Selected accounts" className="space-y-3">
        <h2 className="text-sm font-medium">Selected accounts</h2>
        <p className="text-xs text-subtle-foreground">The pool's latest selection for each provider. Accounts can differ across projects and sessions.</p>
        <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {PROVIDERS.map((provider) => (
            <div key={provider.id} className="min-w-0 rounded-md border border-border px-3 py-2">
              <dt className="text-xs text-subtle-foreground">{provider.title}</dt>
              <dd className="break-all text-sm font-medium">{currentLabel(provider.id)}</dd>
            </div>
          ))}
        </dl>
      </section>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle-foreground/75">
        {[
          { dot: "bg-success", label: "handling traffic" },
          { dot: "bg-warning", label: "near a limit or cap" },
          { dot: "bg-destructive", label: "blocked until reset" },
          {
            dot: "bg-muted-foreground",
            label: "on standby, disabled, or no data",
          },
        ].map((entry) => (
          <span key={entry.label} className="inline-flex items-center gap-1.5">
            <span className={cn("size-1.5 rounded-full", entry.dot)} />
            {entry.label}
          </span>
        ))}
      </p>
      {browserNotice !== null && dialog === null ? <p role="status" className="text-sm text-muted-foreground">{browserNotice.text}</p> : null}
      {browserError !== null && dialog === null ? <p role="alert" className="text-sm text-destructive-text">{browserError.text}</p> : null}
      {error === null ? null : (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-surface-destructive px-3 py-2 text-sm text-destructive-text"
        >
          {error}
        </div>
      )}
      {status !== null && !statusIsCached && accounts.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-5 py-6 text-center">
          <h2 className="text-sm font-semibold text-foreground">
            No accounts in the pool
          </h2>
          <p className="mx-auto mt-1 max-w-lg text-xs leading-relaxed text-muted-foreground">
            Add a Claude, Codex, or Grok account to route threads on all machines
            through it. Your machine&apos;s own login keeps working until then.
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <Button size="sm" onClick={() => void startClaude()}>
              Sign in to Claude
            </Button>
            <Button size="sm" onClick={() => void startCodex()}>
              Sign in to Codex
            </Button>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            or import this machine's login from the target provider's “Add account” menu
          </p>
        </div>
      ) : null}
      {PROVIDERS.map((provider) => {
        const serverAccounts = accounts.filter(
          (account) => account.provider === provider.id,
        );
        const order =
          optimisticOrder?.provider === provider.id
            ? optimisticOrder.ids
            : null;
        const providerAccounts =
          order !== null &&
          order.length === serverAccounts.length &&
          serverAccounts.every((account) => order.includes(account.id))
            ? order.flatMap((id) =>
                serverAccounts.filter((account) => account.id === id),
              )
            : serverAccounts;
        return (
          <SettingsSection
            key={provider.id}
            title={provider.title}
            description={`${provider.description} In flight: ${providerAccounts.reduce((n,a)=>n+a.inFlight,0)}; queued: ${providerAccounts.reduce((n,a)=>n+a.queuedRequests,0)}. Per-account limit: ${config?.maxConcurrentRequestsPerAccount ?? 2}.`}
            action={
              <div className="flex items-center gap-2">
                <Switch
                  checked={status?.routing[provider.id] ?? true}
                  disabled={pending !== null}
                  aria-label={`Route ${provider.title} threads`}
                  onCheckedChange={(enabled) =>
                    void run(`routing-${provider.id}`, async () => {
                      await rpc.call("routing.set", {
                        provider: provider.id,
                        enabled,
                      });
                    })
                  }
                />
                {["codex", "claude", "cursor", "devin", "neuraldeep", "agy"].includes(provider.id) && <label className="flex items-center gap-1 text-xs">
                  <input type="checkbox" aria-label={`VPN only for ${provider.title}`} checked={config?.vpnOnlyProviders?.some(value => value === provider.id) ?? true} disabled={config === null || pending !== null}
                    onChange={e => void saveRouting({ vpnOnlyProviders: e.target.checked
                      ? [...(config?.vpnOnlyProviders ?? []).filter(value => value !== provider.id), provider.id as "codex" | "claude" | "cursor" | "devin" | "neuraldeep" | "agy"]
                      : (config?.vpnOnlyProviders ?? []).filter(value => value !== provider.id) })} />VPN only
                </label>}
                <AddAccountMenu
                  provider={provider.id}
                  onChoose={(choice) => void chooseAdd(provider.id, choice)}
                />
              </div>
            }
          >
            {status === null ? (
              <p className="py-2.5 text-sm text-muted-foreground">Loading…</p>
            ) : providerAccounts.length === 0 ? (
              <p className="py-2.5 text-sm text-subtle-foreground">
                No accounts yet.
              </p>
            ) : (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                modifiers={accountDragModifiers}
                onDragEnd={(event) => void reorderAccounts(provider.id, event)}
              >
                <SortableContext
                  items={providerAccounts.map((account) => account.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="divide-y divide-border">
                    {providerAccounts.map((account) => (
                      <AccountRow
                        key={account.id}
                        account={account}
                        threshold={threshold}
                        current={account.id === currentId(provider.id)}
                        pending={pending !== null}
                        refreshing={
                          statusIsCached || pending === `refresh-${account.id}`
                        }
                        reorderDisabled={providerAccounts.length < 2}
                        onAction={(action) =>
                          void accountAction(account, action)
                        }
                        onOpen={() => {
                          setDialog({ kind: "account", accountId: account.id });
                          void refresh();
                        }}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            )}
          </SettingsSection>
        );
      })}
      <div className="rounded-lg border border-border px-4">
        <div className="py-2.5 text-sm font-medium text-foreground">
          Routing
        </div>
        <div className="divide-y divide-border border-t border-border">
          <ConfigFieldRow
            label="Balance accounts"
            description="New conversations use the account with the most weekly quota remaining before reset. When disabled, accounts are tried by priority."
            error={null}
          >
            <Switch
              checked={config?.routingStrategy === "balanced"}
              disabled={config === null || pending !== null}
              aria-label="Balance accounts"
              onCheckedChange={(enabled) =>
                void saveRouting({
                  routingStrategy: enabled ? "balanced" : "sequential",
                })
              }
            />
          </ConfigFieldRow>
          <div className="py-2.5">
            <div className="text-sm text-foreground">Usage windows</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              When each reserve account joins the primary accounts, measured in working
              hours before its weekly reset.
            </div>
            {reserveAccounts.length === 0 ? (
              <p className="mt-2 text-xs text-subtle-foreground/75">
                No reserve accounts yet.
              </p>
            ) : (
              PROVIDERS.flatMap((provider) => {
                const rows = reserveAccounts.filter(
                  (account) => account.provider === provider.id,
                );
                if (rows.length === 0) return [];
                return [
                  <div key={provider.id} className="mt-3 overflow-x-auto">
                    <div className="text-xs font-medium text-foreground">
                      {provider.title}
                    </div>
                    <table
                      className="mt-1 w-full text-left text-xs"
                      aria-label={`${provider.title} usage windows`}
                    >
                      <thead className="text-subtle-foreground/75">
                        <tr>
                          <th className="py-1 pr-3 font-normal">Account</th>
                          <th className="py-1 pr-3 font-normal">
                            Opens (UTC+3)
                          </th>
                          <th className="py-1 pr-3 font-normal">
                            Weekly reset (UTC+3)
                          </th>
                          <th className="py-1 font-normal">Current cap</th>
                        </tr>
                      </thead>
                      <tbody className="tabular-nums">
                        {rows.map((account) => {
                          const reset = weeklyResetAt(account);
                          const opens = account.drainOpensAt;
                          return (
                            <tr
                              key={account.id}
                              className="border-t border-border"
                            >
                              <td className="py-1 pr-3 whitespace-nowrap">
                                {accountFullName(account)}
                              </td>
                              <td className="py-1 pr-3 whitespace-nowrap">
                                {opens === null
                                  ? "reset unknown"
                                  : opens <= Date.now()
                                    ? "already open"
                                    : moment(opens)}
                              </td>
                              <td className="py-1 pr-3 whitespace-nowrap">
                                {reset === null ? "—" : moment(reset)}
                              </td>
                              <td className="py-1">
                                {percent(account.capLimit)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>,
                ];
              })
            )}
          </div>
          <ConfigFieldRow
            label="Reserve usage hours"
            description="Working hours before the weekly reset when reserve accounts join the primary accounts."
            error={null}
          >
            <Input
              type="number"
              min="1"
              max="168"
              step="1"
              aria-label="Reserve usage hours"
              disabled={config === null || pending !== null}
              value={drainDraft}
              onChange={(event) => {
                setDrainDraft(event.target.value);
                setRoutingError(null);
              }}
              onBlur={() => void saveDrainHours()}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          </ConfigFieldRow>
          <ConfigFieldRow
            label="Rest days"
            description="Days the pool treats as non-working: they do not move accounts closer to reset, so caps stay low over the weekend."
            error={routingError}
          >
            <div>
              <div className="flex flex-wrap gap-1" aria-label="Rest days">
                {WEEKDAY_LABELS.map((title, day) => {
                  const off = (config?.restDays ?? []).includes(day);
                  return (
                    <Button
                      key={title}
                      type="button"
                      size="sm"
                      variant={off ? undefined : "outline"}
                      aria-pressed={off}
                      disabled={config === null || pending !== null}
                      onClick={() =>
                        void saveRouting({
                          restDays: off
                            ? (config?.restDays ?? []).filter(
                                (value) => value !== day,
                              )
                            : [...(config?.restDays ?? []), day].sort(
                                (left, right) => left - right,
                              ),
                        })
                      }
                    >
                      {title}
                    </Button>
                  );
                })}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {daysOffSummary(config?.restDays ?? [])}
              </p>
            </div>
          </ConfigFieldRow>
        </div>
      </div>
      <Collapsible className="rounded-lg border border-border px-4">
        <CollapsibleTrigger className="flex w-full items-center gap-2 py-2.5 text-sm font-medium text-foreground">
          <Icon
            name="ChevronRight"
            className="size-4 transition-transform [[data-state=open]>&]:rotate-90"
          />
          Advanced
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="divide-y divide-border border-t border-border">
            <ConfigFieldRow
              label="Anthropic upstream base URL"
              description="QA override for Anthropic traffic."
              error={configErrors.anthropicUpstreamBaseUrl}
            >
              <Input
                aria-label="Anthropic upstream base URL"
                aria-invalid={
                  configErrors.anthropicUpstreamBaseUrl === null
                    ? undefined
                    : true
                }
                disabled={config === null || pending !== null}
                value={drafts.anthropicUpstreamBaseUrl}
                onChange={(event) =>
                  updateConfigDraft(
                    "anthropicUpstreamBaseUrl",
                    event.target.value,
                  )
                }
                onBlur={() => void saveConfigField("anthropicUpstreamBaseUrl")}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            </ConfigFieldRow>
            <ConfigFieldRow
              label="Codex upstream base URL"
              description="QA override for ChatGPT Codex traffic."
              error={configErrors.codexUpstreamBaseUrl}
            >
              <Input
                aria-label="Codex upstream base URL"
                aria-invalid={
                  configErrors.codexUpstreamBaseUrl === null ? undefined : true
                }
                disabled={config === null || pending !== null}
                value={drafts.codexUpstreamBaseUrl}
                onChange={(event) =>
                  updateConfigDraft("codexUpstreamBaseUrl", event.target.value)
                }
                onBlur={() => void saveConfigField("codexUpstreamBaseUrl")}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            </ConfigFieldRow>
            <ConfigFieldRow label="Concurrent requests per account"
              description="Shared across all machines and clients. Additional requests wait in the queue; provider cooldowns are enforced."
              error={configErrors.maxConcurrentRequestsPerAccount}>
              <Input type="number" min="1" max="32" step="1" aria-label="Concurrent requests per account"
                disabled={config === null || pending !== null} value={drafts.maxConcurrentRequestsPerAccount}
                onChange={event => updateConfigDraft("maxConcurrentRequestsPerAccount",event.target.value)}
                onBlur={() => void saveConfigField("maxConcurrentRequestsPerAccount")}
                onKeyDown={event => {if(event.key === "Enter") event.currentTarget.blur();}} />
            </ConfigFieldRow>
            <ConfigFieldRow
              label="Quota switch threshold"
              description="Do not select an account once this share of its quota is used."
              error={configErrors.switchThreshold}
            >
              <Input
                type="number"
                min="0.01"
                max="1"
                step="0.01"
                aria-label="Quota switch threshold"
                aria-invalid={
                  configErrors.switchThreshold === null ? undefined : true
                }
                disabled={config === null || pending !== null}
                value={drafts.switchThreshold}
                onChange={(event) =>
                  updateConfigDraft("switchThreshold", event.target.value)
                }
                onBlur={() => void saveConfigField("switchThreshold")}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            </ConfigFieldRow>
            <div className="flex items-start justify-between gap-4">
              <div className="py-2.5">
                <div className="text-sm text-foreground">Machine tokens</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {hubHosts}
                </div>
              </div>
              <div className="flex flex-wrap justify-end gap-2 py-2.5">
                {status?.hosts.map((host) => (
                  <Button
                    key={host.hostId}
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void run(`rotate-${host.hostId}`, async () => {
                        await rpc.call("token.rotate", {
                          machine: host.hostId,
                        });
                      })
                    }
                  >
                    Refresh {host.hostName ?? host.hostId}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
      >
        {dialog?.kind === "account" && selectedAccount !== null ? (
          <AccountDialog
            key={selectedAccount.id}
            onPolicyUnsavedChange={setPolicyUnsaved}
            loadProjects={() => rpc.call("projects.list", null)}
            saveAutopilot={async (allowed, expectedAllowed) => {
              try {
                const result = await rpc.call("account.setAutopilotAllowed", {accountId:selectedAccount.id,allowed,expectedAllowed});
                if (!result.account) throw Error("Account removed");
              } finally { await refresh(); }
            }}
            saveProjects={async (projects, expectedProjects) => {
              let result;
              try { result = await rpc.call("account.setProjects", { accountId: selectedAccount.id, projects, expectedProjects }); }
              catch (error) { await refresh(); throw error; }
              if (!result.account) throw new Error("Account removed");
              await refresh();
            }}
            saveEmail={async (email,expectedEmail)=>{
              const result=await rpc.call('account.setEmail',{accountId:selectedAccount.id,email,expectedEmail});
              if(!result.account)throw Error('Account removed');await refresh();
            }}
            savePolicy={async policy => {
              const result = await rpc.call("account.setPolicy", { accountId: selectedAccount.id, policy });
              if (!result.account) throw new Error("Account removed");
              await refresh();
            }}
            account={selectedAccount}
            openBrowser={(url) => void openBrowser(selectedAccount.id, url)}
            browserPending={pending === `browser-${selectedAccount.id}`}
            browserNotice={browserNotice?.accountId === selectedAccount.id ? browserNotice.text : null}
            refreshError={error ?? (browserError?.accountId === selectedAccount.id ? browserError.text : null)}
            threshold={threshold}
            current={selectedAccount.id === currentId(selectedAccount.provider)}
            drainHours={
              config?.reserveDrainHours ??
              DEFAULT_ACCOUNT_POOL_CONFIG.reserveDrainHours
            }
            close={closeDialog}
            pending={pending !== null}
            reauthorize={() => void startClaude(selectedAccount.id)}
            act={(action) => void accountAction(selectedAccount, action)}
          />
        ) : null}
        {dialog?.kind === "priority" && selectedAccount !== null ? (
          <DialogFrame
            title="Priority"
            footer={
              <>
                <span className="flex-1" />
                <Button variant="outline" onClick={closeDialog}>
                  Cancel
                </Button>
                <Button
                  disabled={
                    !Number.isInteger(Number(priority)) || pending !== null
                  }
                  onClick={() =>
                    void run(`priority-${selectedAccount.id}`, async () => {
                      await rpc.call("account.setPriority", {
                        accountId: selectedAccount.id,
                        priority: Number(priority),
                      });
                      setDialog(null);
                    })
                  }
                >
                  Save
                </Button>
              </>
            }
          >
            <p className="text-sm text-muted-foreground">
              Lower numbers are tried first when switching. Ties use account
              creation order. Existing conversations stay on their current
              account.
            </p>
            <Input
              type="number"
              aria-label="Account priority"
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
            />
          </DialogFrame>
        ) : null}
        {dialog?.kind === "role" && selectedAccount !== null ? (
          <DialogFrame
            title="Role"
            footer={
              <>
                <span className="flex-1" />
                <Button variant="outline" onClick={closeDialog}>
                  Cancel
                </Button>
                <Button
                  disabled={pending !== null}
                  onClick={() =>
                    void run(`role-${selectedAccount.id}`, async () => {
                      await rpc.call("account.setRole", {
                        accountId: selectedAccount.id,
                        role: roleDraft,
                      });
                      setDialog(null);
                    })
                  }
                >
                  Save
                </Button>
              </>
            }
          >
            {error === null ? null : <p role="alert" className="text-sm text-destructive-text">{error}</p>}
            <p className="text-sm text-muted-foreground">
              Primary accounts handle traffic as usual. Reserve accounts are used
              only when no primary account is eligible or the weekly reset is near;
              they always stay within their weekly cap.
            </p>
            <div className="flex gap-2">
              {(["primary", "reserve"] as const).map((role) => (
                <Button
                  key={role}
                  variant={roleDraft === role ? undefined : "outline"}
                  aria-pressed={roleDraft === role}
                  onClick={() => setRoleDraft(role)}
                >
                  {role === "primary" ? "Primary" : "Reserve"}
                </Button>
              ))}
            </div>
          </DialogFrame>
        ) : null}
        {dialog?.kind === "cap" && selectedAccount !== null ? (
          <DialogFrame
            title="Weekly cap"
            footer={
              <>
                <Button
                  variant="outline"
                  disabled={pending !== null || selectedAccount.cap === null}
                  onClick={() =>
                    void run(`cap-${selectedAccount.id}`, async () => {
                      await rpc.call("account.setCap", {
                        accountId: selectedAccount.id,
                        cap: null,
                      });
                      setDialog(null);
                    })
                  }
                >
                  Clear cap
                </Button>
                <span className="flex-1" />
                <Button variant="outline" onClick={closeDialog}>
                  Cancel
                </Button>
                <Button
                  disabled={
                    pending !== null ||
                    capDraft.early.trim() === "" ||
                    capDraft.late.trim() === "" ||
                    !Number.isFinite(Number(capDraft.early)) ||
                    !Number.isFinite(Number(capDraft.late))
                  }
                  onClick={() =>
                    void run(`cap-${selectedAccount.id}`, async () => {
                      await rpc.call("account.setCap", {
                        accountId: selectedAccount.id,
                        cap: {
                          early: Number(capDraft.early),
                          late: Number(capDraft.late),
                        },
                      });
                      setDialog(null);
                    })
                  }
                >
                  Save
                </Button>
              </>
            }
          >
            <p className="text-sm text-muted-foreground">
              The pool stops using an account when weekly usage reaches its cap.
              The cap rises from the start-of-week value toward the reset value
              as working time passes. Values range from 0 to 1.
              {selectedAccount.cap === null &&
              selectedAccount.role === "reserve"
                ? " Reserve accounts use a 0.15 to 0.98 cap until you set one."
                : ""}
            </p>
            <div className="grid grid-cols-2 gap-2">
              <Input
                type="number"
                min="0"
                max="1"
                step="0.01"
                aria-label="Cap at start of week"
                value={capDraft.early}
                onChange={(event) =>
                  setCapDraft((current) => ({
                    ...current,
                    early: event.target.value,
                  }))
                }
              />
              <Input
                type="number"
                min="0"
                max="1"
                step="0.01"
                aria-label="Cap at reset"
                value={capDraft.late}
                onChange={(event) =>
                  setCapDraft((current) => ({
                    ...current,
                    late: event.target.value,
                  }))
                }
              />
            </div>
          </DialogFrame>
        ) : null}
        {dialog?.kind === "api-key" ? (
          <DialogFrame
            title={dialog.provider === "claude" ? "Add Anthropic API key" : `Add ${dialog.provider === "devin" ? "PAT" : "API key"} for ${PROVIDERS.find((entry) => entry.id === dialog.provider)?.title ?? dialog.provider}`}
            footer={
              <>
                <span className="flex-1" />
                <Button variant="outline" onClick={closeDialog}>
                  Cancel
                </Button>
                <Button
                  disabled={apiKey.trim().length === 0 || pending !== null}
                  onClick={() =>
                    void run("api-key", async () => {
                      await rpc.call("account.add", {
                        provider: dialog.provider,
                        source: { kind: "api-key", apiKey: apiKey.trim() },
                        label: null,
                        priority: 100,
                      });
                      setApiKey("");
                      setDialog(null);
                    })
                  }
                >
                  Add key
                </Button>
              </>
            }
          >
            <p className="text-sm text-muted-foreground">
              {dialog.provider === "claude" ? "Paid fallback; " : null}
              The key is stored in the account pool's protected secrets directory.
            </p>
            <Input
              type="password"
              autoComplete="off"
              aria-label={dialog.provider === "devin" ? "Devin PAT" : `${dialog.provider === "claude" ? "Anthropic" : PROVIDERS.find((entry) => entry.id === dialog.provider)?.title ?? dialog.provider} API key`}
              placeholder={dialog.provider === "claude" ? "sk-ant-…" : dialog.provider === "devin" ? "cog_…" : undefined}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </DialogFrame>
        ) : null}
        {dialog?.kind === "remove" && selectedAccount !== null ? (
          <DialogFrame
            title={`Delete ${accountFullName(selectedAccount)}?`}
            footer={
              <>
                <span className="flex-1" />
                <Button variant="outline" onClick={closeDialog}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  disabled={pending !== null}
                  onClick={() =>
                    void run(`remove-${selectedAccount.id}`, async () => {
                      await rpc.call("account.remove", {
                        id: selectedAccount.id,
                      });
                      setDialog(null);
                    })
                  }
                >
                  Delete
                </Button>
              </>
            }
          >
            <p className="text-sm text-muted-foreground">
              The account's secret file will be deleted. If no other accounts
              remain in the pool, threads will use their machine's login again.
            </p>
          </DialogFrame>
        ) : null}
        {dialog?.kind==='agy-login'?<DialogFrame title="Sign in to Antigravity" footer={loginDone?<Button onClick={closeDialog}>Done</Button>:<Button disabled={!agyStep||!pastedCode.trim()||pending!==null} onClick={()=>void run('agy-complete',async()=>{
          if(!agyStep)return;
          const added=await rpc.call('agyLogin.complete',{sessionId:agyStep.sessionId,pasted:pastedCode});
          setPastedCode('');setAgyStep(null);setLoginDone(added.label);
        })}>Finish</Button>}>
          {loginDone?<p>Account added: {loginDone}</p>:<>
            <p>Authorize your personal Antigravity subscription with Google. The Pool stores the sign-in on its server.</p>
            <p>After Google confirms sign-in, it will show an authorization code. Paste the code here and select Finish. Do not copy the browser address.</p>
            <Button variant="outline" disabled={!agyStep||pending!==null} onClick={()=>agyStep&&run("agy-browser",async()=>{await rpc.call("agyLogin.openBrowser",{sessionId:agyStep.sessionId});})}>Open Google in Helium</Button>
            <Input aria-label="Google authorization code" value={pastedCode} autoComplete="off" spellCheck={false} type="password" onChange={e=>setPastedCode(e.target.value)}/>
            <p>Sign-in expires in 10 minutes. An active personal Antigravity subscription is required; enterprise sign-in is not supported.</p>
          </>}
          {error?<p role="alert">{error}</p>:null}
        </DialogFrame>:null}
        {dialog?.kind === "claude-login" ? (
          <LoginDialog
            provider="claude"
            reauthorizing={reauthorizeAccountId === null ? null : status?.accounts.find(account => account.id === reauthorizeAccountId)?.email ?? "this account"}
            loginStep={loginStep}
            codexStep={null}
            grokStep={null}
            loginDone={loginDone}
            pending={pending !== null}
            pastedCode={pastedCode}
            countdown={0}
            error={error ?? (browserError?.accountId === reauthorizeAccountId ? browserError.text : null)}
            close={closeDialog}
            openUrl={navigate.openUrl}
            openAccountUrl={reauthorizeAccountId === null ? undefined : url => void openBrowser(reauthorizeAccountId, url)}
            browserNotice={browserNotice?.accountId === reauthorizeAccountId ? browserNotice.text : null}
            setPastedCode={setPastedCode}
            complete={() =>
              void run("complete-claude", async () => {
                if (loginStep === null) return;
                const added = await rpc.call("login.complete", {
                  sessionId: loginStep.sessionId,
                  pasted: pastedCode,
                });
                setLoginDone(added.label);
                setLoginStep(null);
              })
            }
            restart={() => void startClaude(reauthorizeAccountId??undefined)}
          />
        ) : null}
        {dialog?.kind === "grok-login" ? (
          <LoginDialog
            provider="grok"
            loginStep={null}
            codexStep={null}
            grokStep={grokStep}
            loginDone={loginDone}
            pending={pending !== null}
            pastedCode=""
            countdown={countdown}
            error={error}
            close={closeDialog}
            openUrl={navigate.openUrl}
            setPastedCode={() => {}}
            complete={() => {}}
            restart={() => void startGrok()}
          />
        ) : null}
        {dialog?.kind === "codex-login" ? (
          <LoginDialog
            provider="codex"
            loginStep={null}
            codexStep={codexStep}
            grokStep={null}
            loginDone={loginDone}
            pending={pending !== null}
            pastedCode=""
            countdown={countdown}
            error={error}
            close={closeDialog}
            openUrl={navigate.openUrl}
            setPastedCode={() => {}}
            complete={() => {}}
            restart={() => void startCodex()}
          />
        ) : null}
      </Dialog>
    </div>
  );
}

function capSummary(account: AccountSummary): string | null {
  const curve =
    account.cap ?? (account.role === "reserve" ? DEFAULT_RESERVE_CAP : null);
  if (curve === null) return null;
  if (account.drainOnce) return "Temporarily exempt — until exhausted";
  return `${percent(curve.early)} → ${percent(curve.late)}${
    account.capLimit === null ? "" : ` · currently ${percent(account.capLimit)}`
  }`;
}

function AccountDialog({
  account,
  openBrowser,
  browserPending,
  browserNotice,
  saveEmail,
  savePolicy,
  saveProjects,
  saveAutopilot,
  loadProjects,
  onPolicyUnsavedChange,
  refreshError,
  threshold,
  current,
  drainHours,
  close,
  act,
  pending,
  reauthorize,
}: {
  account: AccountSummary;
  openBrowser: (url?: string) => void;
  browserPending: boolean;
  browserNotice: string | null;
  saveEmail:(email:string|null,expectedEmail:string|null)=>Promise<void>;
  saveAutopilot: (allowed:boolean, expectedAllowed:boolean) => Promise<void>;
  saveProjects: (projects: AccountProjects, expectedProjects: AccountProjects | null) => Promise<void>;
  loadProjects: () => Promise<Array<{ id: string; name: string }>>;
  savePolicy: (policy: AccountPolicy) => Promise<void>;
  onPolicyUnsavedChange: (unsaved: boolean) => void;
  refreshError: string | null;
  threshold: number;
  current: boolean;
  drainHours: number;
  close: () => void;
  act: (action: "toggle" | "refresh" | "remove" | "drain" | "role") => void;
  pending: boolean;
  reauthorize: () => void;
}) {
  const [autopilotPending, setAutopilotPending] = useState(false);
  const [autopilotError, setAutopilotError] = useState<string|null>(null);
  const [browserUrl, setBrowserUrl] = useState("");
  const [showBrowserUrl, setShowBrowserUrl] = useState(false);
  const [emailUnsaved,setEmailUnsaved]=useState(false);
  const [projectsUnsaved, setProjectsUnsaved] = useState(false);
  const [quotaUnsaved, setQuotaUnsaved] = useState(false);
  useEffect(() => { onPolicyUnsavedChange(projectsUnsaved || quotaUnsaved || emailUnsaved); }, [projectsUnsaved, quotaUnsaved,emailUnsaved, onPolicyUnsavedChange]);
  const limits = policyThresholds(account, threshold);
  const inheritedThreshold = threshold;
  const inheritedDrainHours = drainHours;
  drainHours = reserveHours(account, drainHours);
  if (account.drainOnce) threshold = 1;
  const cap = capSummary(account);
  const weeklySkipAt =
    account.capLimit === null
      ? limits.weekly
      : Math.min(limits.weekly, account.capLimit);
  const shared = (
    utilization: number | null,
    resetAt: number | null,
    status: string | null,
  ): FamilyQuota => ({
    utilization,
    resetAt,
    status,
    observedAt: account.observedAt ?? 0,
    source: "header",
  });
  const providerId =
    account.provider === "claude"
      ? account.accountUuid
      : account.codexAccountId;
  return (
    <DialogFrame
      title={accountFullName(account)}
      className="pool-settings sm:max-w-xl"
      footer={
        <>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => act("refresh")}>
            Refresh quotas
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" aria-label="More account actions">
                More <Icon name="MoreHorizontal" className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={pending} onSelect={() => act("toggle")}>
                {account.enabled ? "Disable" : "Enable"}
              </DropdownMenuItem>
              {account.provider === "claude" && account.kind === "oauth" && (
                <DropdownMenuItem disabled={pending || projectsUnsaved || quotaUnsaved || emailUnsaved} onSelect={reauthorize}>
                  Reauthorize
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={pending} className="text-destructive-text" onSelect={() => act("remove")}>
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
    >
      <AccountSettingsStyle />
      <section className="pool-browser-section">
        <div className="pool-browser-actions">
          <Button size="sm" variant="outline" disabled={pending} onClick={() => openBrowser()}>
            <Icon name="ExternalLink" className="size-4" />
            {browserPending && !showBrowserUrl ? "Opening…" : "Open in browser"}
          </Button>
          <button type="button" className="pool-settings-link" aria-expanded={showBrowserUrl} aria-controls="pool-browser-link" onClick={() => setShowBrowserUrl(value => !value)} disabled={browserPending}>
            {showBrowserUrl ? "Hide URL" : "Open another URL"}
          </button>
        </div>
        <p className="pool-settings-help">Separate profile · on the Pooler machine</p>
        {showBrowserUrl && <div id="pool-browser-link" className="pool-browser-link">
          <label className="pool-settings-field" htmlFor="pool-browser-url">
            URL to open
            <Input id="pool-browser-url" className="pool-settings-control" type="url" autoComplete="off" placeholder="https://…" value={browserUrl} onChange={event => setBrowserUrl(event.target.value)} disabled={browserPending} />
          </label>
          <Button size="sm" variant="outline" disabled={pending || !browserUrl.trim()} onClick={() => openBrowser(browserUrl)}>
            {browserPending ? "Opening…" : "Open URL"}
          </Button>
        </div>}
        {browserNotice === null ? null : <p role="status" className="pool-settings-help">{browserNotice}</p>}
      </section>
      {account.error&&<p role="alert" className="text-sm text-destructive-text">{account.error}</p>}
      {refreshError === null ? null : <p role="alert" className="text-sm text-destructive-text">{refreshError}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <SettingsBadge>{tier(account)}</SettingsBadge>
        <SettingsBadge>
          {statusPresentation(account, threshold).label}
        </SettingsBadge>
        <SettingsBadge>
          {account.role === "reserve" ? "Reserve" : "Primary"}
        </SettingsBadge>
        <Button size="sm" variant="ghost" className="pool-settings-link" disabled={pending || projectsUnsaved || quotaUnsaved || emailUnsaved} onClick={() => act("role")}>
          Change role
        </Button>
        {current ? <SettingsBadge>Current</SettingsBadge> : null}
      </div>
      {account.kind==='api-key'&&<AccountEmailForm email={account.email} save={saveEmail} onUnsavedChange={setEmailUnsaved}/> }
      <section className="pool-settings-section">
        <label className="pool-settings-toggle">
          <input type="checkbox" checked={account.autopilotAllowed} disabled={pending || autopilotPending}
            onChange={async event => {
              const allowed = event.target.checked;
              setAutopilotPending(true); setAutopilotError(null);
              try { await saveAutopilot(allowed, account.autopilotAllowed); }
              catch { setAutopilotError("Could not save autopilot permission. Refresh the data and try again."); }
              finally { setAutopilotPending(false); }
            }} />
          Allow autopilot
        </label>
        <p className="pool-settings-help">For clients authorized for autopilot. Project and quota limits still apply; manual work is unchanged.</p>
        {autopilotError && <p role="alert">{autopilotError}</p>}
      </section>
      <AccountProjectsForm account={account} loadProjects={loadProjects} save={saveProjects} onUnsavedChange={setProjectsUnsaved} />
      <AccountPolicyForm account={account} threshold={inheritedThreshold} drainHours={inheritedDrainHours} save={savePolicy} onUnsavedChange={setQuotaUnsaved} />
      <section className="pool-settings-section">
      <label className="pool-settings-toggle">
        <input type="checkbox" checked={account.drainOnce === true} disabled={pending}
          onChange={() => act("drain")} />
        Use until exhausted
      </label>
      <p className="pool-settings-help">
        Highest priority across all projects, regardless of project rules, role, schedule, weekly cap, or early switching.
        Turns off when a provider limit is first exhausted. Reset the limit manually.
      </p>
      </section>
      {account.role === "reserve" && !account.drainOnce ? (
        <p className="text-sm text-muted-foreground">
          {`Used only when no primary account is eligible, or within ${drainHours} working hours of its weekly reset.`}
        </p>
      ) : null}
      {cap === null ? null : (
        <div className="grid grid-cols-[7rem_1fr] items-center gap-3 text-sm">
          <div className="text-muted-foreground">Weekly cap</div>
          <div className="min-w-0">{cap}</div>
        </div>
      )}
      <div className="space-y-4">
        {account.provider === "codex" ? (
          account.limitWindows.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No limits observed yet.
            </div>
          ) : (
            account.limitWindows.map((window) => (
              <QuotaDetail
                key={window.slot}
                label={windowLongLabel(window, account.provider)}
                quota={window}
                threshold={window.windowMinutes === 300 ? limits.fiveHour : window.windowMinutes === 10080 ? limits.weekly : limits.other}
                skipAt={
                  (window.windowMinutes ?? 0) >= 1_440
                    ? weeklySkipAt
                    : undefined
                }
              />
            ))
          )
        ) : (
          <>
            <QuotaDetail
              label="5 hours"
              quota={shared(
                account.fiveHourUtilization,
                account.fiveHourResetAt,
                account.fiveHourStatus,
              )}
              threshold={limits.fiveHour}
            />
            <QuotaDetail
              label="7 days"
              quota={shared(
                account.sevenDayUtilization,
                account.sevenDayResetAt,
                account.sevenDayStatus,
              )}
              threshold={limits.weekly}
              skipAt={weeklySkipAt}
            />
            {modelFamilySchema.options.flatMap((family) =>
              account.familyWeekly[family] === null
                ? []
                : [
                    <QuotaDetail
                      key={family}
                      label={FAMILY_LABELS[family]}
                      quota={account.familyWeekly[family]}
                      threshold={limits.weekly}
                      skipAt={weeklySkipAt}
                    />,
                  ],
            )}
          </>
        )}
      </div>
      {account.provider === "codex" || account.provider === "claude" ? (
        <div className="space-y-2 border-t border-border pt-4 text-sm">
          <div className="font-medium">Saved usage limit resets</div>
          {account.resetCredits === null ? (
            <div className="text-muted-foreground">Manual reset data is not available yet.</div>
          ) : (
            <>
              <div>Available: {account.resetCredits.availableCount} · checked {relative(account.resetCredits.observedAt)}</div>
              {account.resetCredits.credits === null ? (
                <div className="text-muted-foreground">Could not retrieve expiration dates.</div>
              ) : account.resetCredits.credits.map((credit, index) => (
                <div key={index} className="text-muted-foreground">
                  <div>{credit.title ?? "Full reset"}{credit.remaining === undefined ? "" : ` · resets: ${credit.remaining}`}</div>
                  <div>{savedResetDeadline(credit.expiresAt)}</div>
                  {credit.limitTypes?.length ? <div>Resets: {credit.limitTypes.map(resetLimitLabel).join(", ")}</div> : null}
                  {credit.usableNow === false ? <div>{credit.requiresLimit ? "Available after reaching the limit" : "Cannot be used now"}</div> : null}
                </div>
              ))}
            </>
          )}
        </div>
      ) : null}
      <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 border-t border-border pt-4 text-sm">
        {account.email === null ? null : (
          <>
            <dt className="text-muted-foreground">Email</dt>
            <dd className="break-all">{account.email}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Type</dt>
        <dd>
          {account.kind === "oauth"
            ? `OAuth · ${account.provider === "claude" ? "claude.ai" : "ChatGPT"}`
            : "API key"}
        </dd>
        <dt className="text-muted-foreground">Priority</dt>
        <dd>{account.priority}</dd>
        <dt className="text-muted-foreground">Requests through pool</dt>
        <dd>{account.successfulRequests.toLocaleString("en-US")} successful since tracking began</dd>
        <dt className="text-muted-foreground">Last used</dt>
        <dd>
          {account.lastUsedAt === null
            ? "Never"
            : `${relative(account.lastUsedAt)}${account.lastUsedHostName === null ? "" : ` · ${account.lastUsedHostName}`}`}
        </dd>
        <dt className="text-muted-foreground">Quotas refreshed</dt>
        <dd>
          {account.observedAt === null
            ? "Never"
            : relative(account.observedAt)}
        </dd>
        {providerId === null || providerId === undefined ? null : (
          <>
            <dt className="text-muted-foreground">Account ID</dt>
            <dd className="font-mono text-xs">{`${providerId.slice(0, 4)}…${providerId.slice(-4)}`}</dd>
          </>
        )}
      </dl>
    </DialogFrame>
  );
}

function LoginDialog({
  provider,
  reauthorizing = null,
  loginStep,
  codexStep,
  grokStep,
  loginDone,
  pending,
  pastedCode,
  countdown,
  error,
  close,
  openUrl,
  openAccountUrl,
  browserNotice = null,
  setPastedCode,
  complete,
  restart,
}: {
  provider: PoolProvider;
  reauthorizing?: string | null;
  loginStep: OAuthLoginStart | null;
  codexStep: CodexDeviceLoginStart | null;
  grokStep: GrokDeviceLoginStart | null;
  loginDone: string | null;
  pending: boolean;
  pastedCode: string;
  countdown: number;
  error: string | null;
  close: () => void;
  openUrl: (url: string) => boolean;
  openAccountUrl?: (url: string) => void;
  browserNotice?: string | null;
  setPastedCode: (value: string) => void;
  complete: () => void;
  restart: () => void;
}) {
  const name = provider === "claude" ? "Claude" : provider === "grok" ? "Grok" : "Codex";
  const url = provider === "claude" ? loginStep?.authorizeUrl : provider === "grok" ? grokStep?.verificationUri : codexStep?.verificationUri;
  const deviceStep = provider === "grok" ? grokStep : codexStep;
  return (
    <DialogFrame
      title={reauthorizing === null ? `Sign in to ${name}` : "Reauthorize Claude"}
      className="sm:max-w-xl"
      footer={
        loginDone !== null ? (
          <>
            <span className="flex-1" />
            {reauthorizing === null ? <Button variant="outline" onClick={restart}>Add another</Button> : null}
            <Button onClick={close}>Done</Button>
          </>
        ) : provider === "claude" ? (
          <>
            <span className="flex-1" />
            <Button
              disabled={
                loginStep === null || pastedCode.trim().length === 0 || pending
              }
              onClick={complete}
            >
              Finish
            </Button>
          </>
        ) : null
      }
    >
      <StepIndicator step={loginDone === null ? 2 : 3} />
      {loginDone !== null ? (
        <div>
          <h3 className="text-base font-semibold">{reauthorizing === null ? "Connected" : "Authorization updated:"} {loginDone}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {reauthorizing === null ? `Account added to the ${name} pool. Quotas are refreshing in the background.` : "Settings saved. A disabled account stays disabled; its role and project rules are unchanged."}
          </p>
        </div>
      ) : url === undefined ? (
        error !== null ? (
          <div className="space-y-3">
            <p className="text-sm text-destructive-text">{error}</p>
            <Button variant="outline" onClick={restart}>
              Try again
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Starting sign-in…</p>
        )
      ) : (
        <>
          {error === null ? null : <div className="space-y-2">
            <p role="alert" className="text-sm text-destructive-text">{error}</p>
            <Button variant="outline" disabled={pending} onClick={restart}>Try again</Button>
          </div>}
          <p className="text-sm text-muted-foreground">
            {provider === "claude"
              ? "Sign in at claude.ai, then paste the code from the final page."
              : provider === "grok"
                ? "Open the verification page, sign in to Grok, and enter this code. The Pool stores the resulting credentials on its server."
                : "Open the verification page, sign in to ChatGPT, and enter this code."}
          </p>
          {reauthorizing === null ? null : <p className="text-sm text-muted-foreground">Sign in to {reauthorizing}. Signing in to another account will not replace this subscription.</p>}
          {deviceStep === null ? null : (
            <UserCodeBlock userCode={deviceStep.userCode} provider={provider === "grok" ? "Grok" : "Codex"} />
          )}
          <AuthorizationUrlRow name={name} url={url} openUrl={openUrl} />
          {openAccountUrl === undefined ? null : <div className="space-y-1">
            <Button variant="outline" disabled={pending} onClick={() => openAccountUrl(url)}>Open in account profile</Button>
            <p className="text-sm text-muted-foreground">The window will open on the Pooler machine.</p>
            {browserNotice === null ? null : <p role="status" className="text-sm text-muted-foreground">{browserNotice}</p>}
          </div>}
          {provider === "claude" ? (
            <Input
              aria-label="Claude authorization code"
              placeholder="Paste code#state here"
              value={pastedCode}
              onChange={(event) => setPastedCode(event.target.value)}
            />
          ) : (
            <p className="text-center text-sm text-muted-foreground">
              Waiting for authorization… {Math.floor(countdown / 60)}:
              {String(countdown % 60).padStart(2, "0")}
            </p>
          )}
        </>
      )}
    </DialogFrame>
  );
}

export function ThreadAccountIndicator({ threadId, isCompactViewport }: { threadId: string; isCompactViewport: boolean }) {
  const rpc = useRpc<typeof accountPoolRpcContract>();
  const [status, setStatus] = useState<ThreadAccountStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    let disposed = false;
    let running = false;
    setStatus(null);
    setError(false);
    const refresh = async () => {
      if (running) return;
      running = true;
      try {
        const result = await rpc.call("thread.account", { threadId });
        if (!disposed) { setStatus(result); setError(false); }
      } catch { if (!disposed) setError(true); }
      finally { running = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => { disposed = true; clearInterval(timer); };
  }, [rpc, threadId]);
  if (status?.state === "unsupported") return null;
  const account = status?.account;
  const availability = account === null || account === undefined ? "" : !account.enabled ? "disabled" : account.eligible ? "eligible" : "currently unavailable";
  const label = error ? "Pool: status check failed" : status === null ? "Pool: checking…" : status.state === "bypassed" ? "Outside pool" : status.state === "unobserved" ? "Pool: no data yet" : `${(account ? accountFullName(account) : "Deleted account")} · ${availability}`;
  const details = status?.state === "observed"
    ? `Last confirmed request: ${label}. ${status.lastUsedAt === null ? "" : new Date(status.lastUsedAt).toLocaleString("en-US")}. The next request may use a different account. Active requests for this account: ${account?.inFlight ?? 0}.`
    : "The account is selected when a request is made. Only confirmed pool data is shown here.";
  return <>
    <button type="button" className="max-w-64 truncate text-xs text-muted-foreground" title={details} aria-label={`Thread account: ${label}`} onClick={() => setOpen(true)}>{isCompactViewport ? "Pool" : label}</button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogFrame title="Thread account" footer={<Button onClick={() => setOpen(false)}>Close</Button>}>
        <p>{label}</p><p className="text-sm text-muted-foreground">{details}</p>
        {account ? <p className="text-sm">{account.role === "reserve" ? "Reserve" : "Primary"} · {account.provider} · quotas refreshed {account.observedAt === null ? "never" : new Date(account.observedAt).toLocaleString("en-US")}</p> : null}
      </DialogFrame>
    </Dialog>
  </>;
}

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({ id: "pool-account", title: "Thread account", component: ThreadAccountIndicator });
  app.slots.settingsSection({
    id: "accounts",
    component: AccountPoolSettings,
  });
});
