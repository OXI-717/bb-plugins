import type { ComponentType } from "react";

/**
 * Minimal preview shim for `@get-bb/plugin-sdk/app`. The real `app.tsx` is
 * imported against this module, so its actual registration loop runs here
 * and every `experimental_providerIcon` call is captured below. The host's
 * own resolver is intentionally not reproduced.
 */
export interface PreviewProviderIconRegistration {
  providerKind: "agent" | "environment" | "machine";
  providerId: string;
  icon: ComponentType<{ className?: string }>;
}

const registrations: PreviewProviderIconRegistration[] = [];

const previewApp = {
  slots: {
    experimental_providerIcon: (registration: PreviewProviderIconRegistration) => {
      registrations.push(registration);
    },
  },
};

export function definePluginApp(factory: (app: typeof previewApp) => unknown) {
  factory(previewApp);
  return { registeredProviderIcons: registrations.length };
}

export function registeredProviderIcons(): readonly PreviewProviderIconRegistration[] {
  return registrations;
}
