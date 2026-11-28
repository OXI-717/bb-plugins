import { createRoot } from "react-dom/client";
import { useState } from "react";
import type { ComponentType } from "react";
// The real registration loop from app.tsx runs at import time against the
// aliased preview shim, so every captured mark below is a real component.
import "../app.js";
import { registeredProviderIcons } from "./sdk.js";

interface PreviewRow {
  id: string;
  name: string;
}

const REGISTRY_ROWS: PreviewRow[] = [
  { id: "acp-agy", name: "Antigravity" },
  { id: "acp-opencode-kimi", name: "Kimi" },
  { id: "acp-oxi-cursor", name: "Cursor" },
  { id: "acp-oxi-devin-pool", name: "Devin" },
  { id: "acp-opencode-go", name: "OpenCode Go" },
  { id: "acp-opencode-zai", name: "Z.ai" },
  { id: "acp-opencode-neuraldeep", name: "NeuralDeep" },
];

// Deliberately not claimed: builtins and unknown ids keep the host artwork.
const FALLBACK_ROWS: PreviewRow[] = [
  { id: "codex", name: "Codex" },
  { id: "claude-code", name: "Claude Code" },
  { id: "acp-cursor", name: "Cursor" },
  { id: "acp-demo-unknown", name: "Unknown provider" },
];

const ALL_ROWS: PreviewRow[] = [...REGISTRY_ROWS, ...FALLBACK_ROWS];

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
const pane = Number(params.get("pane")) || null;
document.documentElement.classList.toggle("dark", theme === "dark");

const registrations = registeredProviderIcons();

function resolveMark(
  providerId: string,
): ComponentType<{ className?: string }> | undefined {
  return registrations.find(
    (r) => r.providerKind === "agent" && r.providerId === providerId,
  )?.icon;
}

const BUILTIN_IDS = new Set(["codex", "claude-code", "acp-cursor"]);

/**
 * Synthetic stand-in for the host's builtin provider mark. The core renders
 * builtin marks exactly like the plugin's: a `bg-current` mask span. The
 * mask geometry below is neutral chrome, not a real brand asset.
 */
const BUILTIN_MASK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><rect x="4" y="7.5" width="16" height="11.5" rx="3" fill="none" stroke="#000" stroke-width="1.8"/><circle cx="9.5" cy="13.2" r="1.4" fill="#000"/><circle cx="14.5" cy="13.2" r="1.4" fill="#000"/><path d="M12 7.5V4.6" fill="none" stroke="#000" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="3.6" r="1.1" fill="#000"/></svg>';
const BUILTIN_MASK_URL = `url("data:image/svg+xml,${encodeURIComponent(BUILTIN_MASK_SVG)}")`;

function BuiltinMark({ className }: { className?: string }) {
  return (
    <span
      className={`inline-block ${className ?? ""} shrink-0 bg-current`.trim()}
      style={{
        maskImage: BUILTIN_MASK_URL,
        WebkitMaskImage: BUILTIN_MASK_URL,
        maskRepeat: "no-repeat",
        WebkitMaskRepeat: "no-repeat",
        maskPosition: "center",
        WebkitMaskPosition: "center",
        maskSize: "contain",
        WebkitMaskSize: "contain",
      }}
    />
  );
}

/**
 * Stand-in for the host's unknown-provider fallback: a Lucide-style SVG
 * with explicit width/height 24 and a viewBox, sized by `size-full`.
 */
function UnknownLucideGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <path d="M12 17h.01" />
    </svg>
  );
}

/**
 * The core's ProviderIcon slot with the live drawer geometry: an
 * `inline-flex min-h-max min-w-max shrink-0 size-4` wrapper (size-5 under
 * `max-md:pointer-coarse`) whose child is the registered mark, the builtin
 * mask span, or the Lucide fallback, each receiving `size-full`.
 */
function ProviderIconSlot({ providerId }: { providerId: string }) {
  const Icon = resolveMark(providerId);
  return (
    <span
      className="inline-flex min-h-max min-w-max shrink-0 items-center justify-center size-4 max-md:pointer-coarse:size-5"
      aria-hidden="true"
      data-fixture="icon-wrap"
    >
      {Icon ? (
        <Icon className="size-full" />
      ) : BUILTIN_IDS.has(providerId) ? (
        <BuiltinMark className="size-full" />
      ) : (
        <UnknownLucideGlyph className="size-full" />
      )}
    </span>
  );
}

/**
 * Same slot in the provider usage header surface: a `size-6` wrapper.
 */
function UsageIconSlot({ providerId }: { providerId: string }) {
  const Icon = resolveMark(providerId);
  return (
    <span
      className="inline-flex min-h-max min-w-max shrink-0 items-center justify-center size-6"
      aria-hidden="true"
      data-fixture="usage-wrap"
    >
      {Icon ? (
        <Icon className="size-full" />
      ) : BUILTIN_IDS.has(providerId) ? (
        <BuiltinMark className="size-full" />
      ) : (
        <UnknownLucideGlyph className="size-full" />
      )}
    </span>
  );
}

function href(changes: Record<string, string | null>) {
  const query = new URLSearchParams(location.search);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) query.delete(key);
    else query.set(key, value);
  }
  const text = query.toString();
  return text ? `?${text}` : location.pathname;
}

function Toolbar() {
  return (
    <nav className="toolbar" aria-label="Preview controls">
      <a href={href({ theme: "light" })} aria-current={theme === "light"}>
        Light
      </a>
      <a href={href({ theme: "dark" })} aria-current={theme === "dark"}>
        Dark
      </a>
      <span className="sep" aria-hidden="true" />
      <a href={href({ pane: null })} aria-current={!pane}>
        Desktop
      </a>
      <a href={href({ pane: "768" })} aria-current={pane === 768}>
        768 px
      </a>
      <a href={href({ pane: "390" })} aria-current={pane === 390}>
        390 px
      </a>
    </nav>
  );
}

/**
 * Live-DOM replica of the mobile model-picker drawer. Classes, the inline
 * width/min/max override and the native handler set follow the host markup;
 * the selected tab is fixture chrome for tap verification.
 */
function ModelPickerDrawer({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="drawer-shell">
      <div
        className="flex min-h-0 flex-col p-0 w-max min-w-64 max-w-80 flex-1 overflow-y-hidden"
        style={{ width: "auto", minWidth: "auto", maxWidth: "none" }}
        data-fixture="provider-drawer"
        role="group"
        aria-label="Model picker provider tabs"
      >
        <div
          className="flex shrink-0 items-center gap-0.5 border-b border-border bg-background px-2.5 pt-1"
          data-fixture="provider-row"
        >
          {ALL_ROWS.map((row) => (
            <button
              type="button"
              key={row.id}
              className="provider-tab flex items-center justify-center border-b-2 focus-visible:outline-none transition-none h-7 w-6 max-md:pointer-coarse:h-9 max-md:pointer-coarse:w-9 border-transparent text-muted-foreground hover:text-foreground"
              data-provider-id={row.id}
              aria-label={row.name}
              aria-pressed={selected === row.id}
              onMouseDown={(event) => event.preventDefault()}
              onPointerEnter={() => {}}
              onFocus={() => {}}
              onClick={() => onSelect(row.id)}
            >
              <ProviderIconSlot providerId={row.id} />
            </button>
          ))}
        </div>
        <div className="drawer-content" data-fixture="drawer-content">
          <p className="status" data-selected-id={selected ?? "none"}>
            Selected: {selected ?? "none"}
          </p>
          <p className="hint">
            Tap any provider tab. The status line must always name the tab
            that was actually tapped.
          </p>
        </div>
      </div>
    </div>
  );
}

function UsageHeader() {
  return (
    <div className="panel" aria-label="Provider usage">
      {ALL_ROWS.map((row) => (
        <div className="usage-row" key={row.id} data-provider-id={row.id}>
          <UsageIconSlot providerId={row.id} />
          <span className="name">{row.name}</span>
          <span className="pid">{row.id}</span>
        </div>
      ))}
    </div>
  );
}

function PreviewPage() {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <main style={pane ? { maxWidth: `${pane}px` } : undefined}>
      <Toolbar />
      <h2>Model picker drawer — live-DOM replica, 11 provider tabs</h2>
      <p className="hint">
        Drawer <code>flex min-h-0 flex-col p-0 w-max min-w-64 max-w-80 flex-1
        overflow-y-hidden</code> with the host&apos;s inline{" "}
        <code>width:auto;min-width:auto;max-width:none</code> override; tabs
        row <code>flex shrink-0 items-center gap-0.5 border-b border-border
        bg-background px-2.5 pt-1</code>; tabs{" "}
        <code>h-7 w-6</code> growing to <code>h-9 w-9</code> only under{" "}
        <code>max-md:pointer-coarse</code>; icon wrapper{" "}
        <code>size-4</code> → <code>size-5</code> on the same rule; every
        child is <code>size-full</code>. Registered marks are the real
        components from icons.tsx through app.tsx.
      </p>
      <ModelPickerDrawer selected={selected} onSelect={setSelected} />
      <h2>Provider usage header — size-6 wrapper</h2>
      <div className="panel" aria-label="Provider usage legend">
        <p className="hint">
          Registered agent ids: {registrations.length}. Not claimed: codex,
          claude-code, acp-cursor and unknown ids — the host keeps its own
          artwork, and disabling this plugin restores it everywhere.
        </p>
      </div>
      <UsageHeader />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<PreviewPage />);
