import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { providerIconIds, providerIconRegistry } from "./icons.js";

/**
 * Presentation-only frontend. Registers exactly one agent-provider mark per
 * public-safe provider id from the single registry in `icons.tsx`.
 *
 * The host keeps its own glyphs for every other provider; disabling this
 * plugin (or any surface shown before this bundle loads) falls back to them.
 */
export default definePluginApp((app) => {
  for (const providerId of providerIconIds) {
    app.slots.experimental_providerIcon({
      providerKind: "agent",
      providerId,
      icon: providerIconRegistry[providerId],
    });
  }
});
