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

/**
 * Synthetic stand-in for the host's default glyph. Like real host artwork
 * it carries explicit intrinsic width/height, so fallback rows exercise the
 * host's own well-formed path rather than the plugin's mark renderer.
 */
function HostGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="24"
      height="24"
      aria-hidden="true"
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect
        x="4"
        y="7.5"
        width="16"
        height="11.5"
        rx="3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <circle cx="9.5" cy="13.2" r="1.4" fill="currentColor" />
      <circle cx="14.5" cy="13.2" r="1.4" fill="currentColor" />
      <path
        d="M12 7.5V4.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="12" cy="3.6" r="1.1" fill="currentColor" />
    </svg>
  );
}

/**
 * The host's ProviderIcon slot: the wrapper span the core renders around
 * whatever the plugin returns, with the host `className` handed down. In
 * the mobile drawer the wrapper is 16 px (20 px on coarse pointers) with
 * `min-w-max min-h-max shrink-0`; in the usage header it is 24 px
 * (`size-6`). The mark child is always `size-full`.
 */
function ProviderIconSlot({
  providerId,
  wrapperClass,
  fixture,
}: {
  providerId: string;
  wrapperClass: string;
  fixture: string;
}) {
  const Icon = resolveMark(providerId);
  return (
    <span className={wrapperClass} data-fixture={fixture}>
      {Icon ? (
        <Icon className="size-full" />
      ) : (
        <HostGlyph className="size-full" />
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
 * Native replica of the mobile model-picker drawer: outer Drawer with
 * width/min/max auto, a row of eleven provider buttons (flex-shrink 1,
 * min-width auto, h-7 w-6 on fine pointers, h-9 w-9 on coarse), each
 * wrapping its mark in the 16/20 px min-w-max icon wrapper.
 */
function ModelPickerDrawer({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div
      className="drawer w-auto min-w-auto max-w-auto"
      data-fixture="provider-drawer"
      role="group"
      aria-label="Model picker provider drawer"
    >
      <div className="drawer-row" data-fixture="provider-row">
        {ALL_ROWS.map((row) => (
          <button
            type="button"
            key={row.id}
            className="provider-btn"
            data-provider-id={row.id}
            aria-label={row.name}
            aria-pressed={selected === row.id}
            onClick={() => onSelect(row.id)}
          >
            <ProviderIconSlot
              providerId={row.id}
              wrapperClass="icon-wrap"
              fixture="icon-wrap"
            />
          </button>
        ))}
      </div>
    </div>
  );
}

function UsageHeader() {
  return (
    <div className="panel" aria-label="Provider usage">
      {ALL_ROWS.map((row) => (
        <div className="usage-row" key={row.id} data-provider-id={row.id}>
          <ProviderIconSlot
            providerId={row.id}
            wrapperClass="usage-wrap"
            fixture="usage-wrap"
          />
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
      <h2>Model picker drawer — native replica, 11 provider buttons</h2>
      <p className="hint">
        Drawer width/min/max auto, row gap 0.5 / padding-x 2.5 /
        overflow-visible; buttons shrink-1 min-w-auto, h-7 w-6 (h-9 w-9 on
        coarse pointers); icon wrapper 16 px (20 px coarse) with min-w-max /
        min-h-max / shrink-0; mark child size-full. Tap any provider: the
        status line must always show the tapped button&apos;s id.
      </p>
      <ModelPickerDrawer selected={selected} onSelect={setSelected} />
      <p className="status" data-selected-id={selected ?? "none"}>
        Selected: {selected ?? "none"}
      </p>
      <h2>Provider usage header — native size-6 wrapper, 16 px marks</h2>
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
