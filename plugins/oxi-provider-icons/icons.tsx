import type { ComponentType } from "react";

/**
 * Inline, theme-aware provider marks for `slots.experimental_providerIcon`.
 *
 * Every mark is static SVG geometry painted with `currentColor`: no scripts,
 * no external references, no network access. The host passes its sizing
 * `className`; marks are designed to stay legible at 14 and 16 px.
 *
 * Geometry provenance is documented in THIRD_PARTY_NOTICES.md: five marks
 * reuse upstream BB (MIT) brand assets, two are local monograms.
 */

export interface ProviderIconProps {
  className?: string;
}

function iconProps(className: string | undefined) {
  return {
    className,
    viewBox: "0 0 24 24",
    "aria-hidden": "true" as const,
    focusable: "false" as const,
    xmlns: "http://www.w3.org/2000/svg",
  };
}

/* Upstream BB (MIT) brand asset: provider-acp icons/registry-antigravity-acp.svg */
export function AntigravityIcon({ className }: ProviderIconProps) {
  return (
    <svg {...iconProps(className)}>
      <path
        transform="scale(1.5)"
        fill="currentColor"
        d="M14.1452 14.6818C14.9937 15.3182 16.2664 14.894 15.0997 13.7273C11.5998 10.3333 12.3421 1 7.99366 1C3.64518 1 4.3876 10.3333 0.887603 13.7273C-0.385123 15 0.993664 15.3182 1.84215 14.6818C5.13002 12.4545 4.9179 8.5303 7.99366 8.5303C11.0694 8.5303 10.8573 12.4545 14.1452 14.6818Z"
      />
    </svg>
  );
}

/* Upstream BB (MIT) brand asset: provider-acp icons/registry-kimi-code.svg */
export function KimiCodeIcon({ className }: ProviderIconProps) {
  return (
    <svg {...iconProps(className)}>
      <path
        fill="currentColor"
        d="M19.514 7.342C19.711 7.862 19.814 8.413 19.816 8.969C19.816 12.494 15.998 14.697 12.946 12.934C11.529 12.116 10.657 10.605 10.657 8.969C10.657 5.646 14.085 3.431 17.115 4.793C15.26 3.373 12.99 2.607 10.655 2.612C4.772 2.614 0.005 7.381 0 13.265C0.002 19.148 4.772 23.918 10.655 23.92C16.538 23.916 21.306 19.147 21.31 13.265C21.312 11.155 20.687 9.095 19.514 7.342ZM14.841 4.666C14.841 8.191 18.657 10.395 21.709 8.632C23.127 7.814 24 6.302 24 4.666C24 1.14 20.184-1.061 17.13 0.699C15.714 1.519 14.841 3.03 14.841 4.666"
      />
    </svg>
  );
}

/* Upstream BB (MIT) brand asset: provider-acp icons/cursor.svg, plus a
   small two-dot "pool" badge distinguishing the pooled route. */
export function CursorPoolIcon({ className }: ProviderIconProps) {
  return (
    <svg {...iconProps(className)}>
      <g transform="translate(1.2 1.2) scale(0.7)">
        <path
          fill="currentColor"
          d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23"
        />
      </g>
      <circle cx="18.7" cy="21.5" r="1.7" fill="currentColor" />
      <circle cx="21.5" cy="18.7" r="1.7" fill="currentColor" />
    </svg>
  );
}

/* Upstream BB (MIT) brand asset: provider-acp icons/registry-devin.svg, plus
   the same two-dot "pool" badge. */
export function DevinPoolIcon({ className }: ProviderIconProps) {
  return (
    <svg {...iconProps(className)}>
      <g transform="translate(2.235 1.2) scale(0.056)">
        <path
          fill="currentColor"
          d="M1.84577e-10 100.797V38.6224C1.88813e-05 35.8899 1.45777 33.365 3.82414 31.9988L57.6539 0.920185C60.0203 -0.446051 62.9358 -0.446051 65.3022 0.920185L119.132 31.9988C121.498 33.3651 122.956 35.8899 122.956 38.6224V70.375C123.192 80.9262 128.769 91.103 138.577 96.7655C148.384 102.428 159.986 102.169 169.242 97.0979L196.74 81.2217C199.107 79.8554 202.022 79.8554 204.388 81.2217L258.218 112.3C260.585 113.667 262.042 116.191 262.042 118.924V181.081C262.042 183.814 260.585 186.339 258.218 187.705L204.388 218.783C202.022 220.15 199.107 220.15 196.74 218.783L169.464 203.036C160.173 197.847 148.465 197.536 138.579 203.244C128.772 208.906 123.195 219.083 122.959 229.634V261.378C122.959 264.111 121.501 266.635 119.135 268.002L65.3048 299.08C62.9384 300.447 60.0229 300.447 57.6566 299.08L3.82673 268.002C1.46036 266.635 0.00260562 264.111 0.00260562 261.378V199.221C0.0026245 196.488 1.46038 193.963 3.82675 192.597L57.6565 161.519C60.0229 160.152 62.9384 160.152 65.3048 161.519L92.8656 177.431C102.11 182.467 113.679 182.711 123.463 177.062C133.349 171.355 138.934 161.06 139.086 150.419C138.85 139.868 133.274 128.601 123.466 122.938C113.658 117.276 102.056 117.534 92.8007 122.606L65.1758 138.645C62.7991 140.025 59.8649 140.024 57.4894 138.642L3.80216 107.407C1.44816 106.038 -1.88809e-05 103.52 1.84577e-10 100.797Z"
        />
      </g>
      <circle cx="18.7" cy="21.5" r="1.7" fill="currentColor" />
      <circle cx="21.5" cy="18.7" r="1.7" fill="currentColor" />
    </svg>
  );
}

/* Upstream BB (MIT) brand asset: provider-acp icons/opencode.svg, plus a
   small chevron "go" badge distinguishing the hosted Go route. */
export function OpenCodeGoIcon({ className }: ProviderIconProps) {
  return (
    <svg {...iconProps(className)}>
      <g transform="translate(4.35 3.0375) scale(0.04375)">
        <path fill="currentColor" fillOpacity="0.45" d="M180 240H60V120H180V240Z" />
        <path fill="currentColor" d="M180 60H60V240H180V60ZM240 300H0V0H240V300Z" />
      </g>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M18.6 17.8 21.2 20.4 18.6 23"
      />
    </svg>
  );
}

/* Local monogram for Z.ai: a plain geometric "Z", not an official logo. */
export function ZaiMonogramIcon({ className }: ProviderIconProps) {
  return (
    <svg {...iconProps(className)}>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M4.5 4.5h15L4.5 19.5h15"
      />
    </svg>
  );
}

/* Local monogram for NeuralDeep: plain geometric "ND", not an official logo. */
export function NeuralDeepMonogramIcon({ className }: ProviderIconProps) {
  return (
    <svg {...iconProps(className)}>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M2.8 20.5V4l7.4 15.5V3.5"
      />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M13.8 3.5h3.2a5 8.5 0 0 1 0 17h-3.2z"
      />
    </svg>
  );
}

/**
 * The single explicit registry: exact agent provider id to its mark.
 * Only these seven public-safe ids are claimed; built-in providers
 * (`codex`, `claude-code`, `acp-cursor`) and unknown ids keep the host's
 * standard glyph through its fallback.
 */
export const providerIconRegistry = {
  "acp-agy": AntigravityIcon,
  "acp-opencode-kimi": KimiCodeIcon,
  "acp-oxi-cursor": CursorPoolIcon,
  "acp-oxi-devin-pool": DevinPoolIcon,
  "acp-opencode-go": OpenCodeGoIcon,
  "acp-opencode-zai": ZaiMonogramIcon,
  "acp-opencode-neuraldeep": NeuralDeepMonogramIcon,
} as const satisfies Record<string, ComponentType<ProviderIconProps>>;

export type ProviderIconId = keyof typeof providerIconRegistry;

export const providerIconIds: readonly ProviderIconId[] = Object.keys(
  providerIconRegistry,
) as ProviderIconId[];
