import { createRoot } from "react-dom/client";
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

const USAGE = [34, 72, 18, 55, 90, 42, 8];

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

/** Synthetic stand-in for the host's default glyph: honest chrome, not art. */
function HostGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
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

function Mark({ providerId, size }: { providerId: string; size: 14 | 16 }) {
  const Icon = resolveMark(providerId);
  const className = `pi pi-${size}`;
  return Icon ? (
    <Icon className={className} />
  ) : (
    <HostGlyph className={className} />
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

function PreviewPage() {
  return (
    <main style={pane ? { maxWidth: `${pane}px` } : undefined}>
      <Toolbar />
      <h2>Model picker — synthetic surface, 16 px marks</h2>
      <div className="panel" role="listbox" aria-label="Agent provider picker">
        {REGISTRY_ROWS.map((row) => (
          <div className="row" key={row.id} role="option" aria-selected="false">
            <Mark providerId={row.id} size={16} />
            <span className="name">{row.name}</span>
            <span className="pid">{row.id}</span>
          </div>
        ))}
      </div>
      <h2>Provider usage header — synthetic surface, 14 px marks</h2>
      <div className="panel" aria-label="Provider usage">
        {REGISTRY_ROWS.map((row, index) => (
          <div className="row" key={row.id}>
            <Mark providerId={row.id} size={14} />
            <span className="name">{row.name}</span>
            <span className="usage" aria-hidden="true">
              <i style={{ width: `${USAGE[index]}%` }} />
            </span>
            <span className="pid">{USAGE[index]}%</span>
          </div>
        ))}
      </div>
      <h2>Registry control — 7 registered + builtin/unknown fallback</h2>
      <p className="hint">
        Registered cards draw the real components from icons.tsx. Fallback
        cards draw a synthetic host glyph because those ids are deliberately
        not claimed.
      </p>
      <div className="cards">
        {[...REGISTRY_ROWS, ...FALLBACK_ROWS].map((row) => {
          const registered = Boolean(resolveMark(row.id));
          return (
            <div className="card" key={row.id}>
              <div className="pair">
                <Mark providerId={row.id} size={16} />
                <Mark providerId={row.id} size={14} />
              </div>
              <span className="name">{row.name}</span>
              <span className="id">{row.id}</span>
              <span
                className={registered ? "badge registered" : "badge"}
              >
                {registered ? "registered" : "host fallback"}
              </span>
            </div>
          );
        })}
      </div>
      <p className="hint">
        Registered agent ids: {registrations.length}. Not claimed: codex,
        claude-code, acp-cursor and unknown ids — the host keeps its own
        artwork, and disabling this plugin restores it everywhere.
      </p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<PreviewPage />);
