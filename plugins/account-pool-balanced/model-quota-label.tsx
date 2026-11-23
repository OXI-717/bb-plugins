import { createContext, useContext, useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { experimental_Icon as Icon, experimental_ProviderIcon as ProviderIcon, useSdk } from "@get-bb/plugin-sdk/app";
import { USAGE_PROVIDER_IDS } from "./src/usage-provider-ids.js";

type Provider = ComponentProps<typeof ProviderIcon>["provider"];
const Catalog = createContext<ReadonlyMap<string, Provider> | null>(null);

export function GeminiModelCatalog({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const sdk = useSdk();
  const [catalog, setCatalog] = useState<Map<string, Provider> | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const providerId = USAGE_PROVIDER_IDS.gemini;
    async function readModels() {
      try {
        const result = await sdk.providers.models({ providerId, signal: controller.signal });
        const providers = new Map(result.providers.map(provider => [provider.id, provider]));
        const entries = new Map<string, Provider>();
        for (const model of result.models) {
          const provider = providers.get(model.routeProviderId ?? providerId);
          if (!provider) continue;
          entries.set(model.id, provider);
          entries.set(model.model, provider);
        }
        if (!controller.signal.aborted) setCatalog(entries);
      } catch {
        // Model artwork is optional. Quota rows remain readable when discovery fails.
        if (!controller.signal.aborted) setCatalog(null);
      }
    }
    void readModels();
    return () => controller.abort();
  }, [enabled, sdk]);
  return <Catalog.Provider value={enabled ? catalog : null}>{children}</Catalog.Provider>;
}

export function ModelQuotaLabel({ model, children }: { model: string | null; children: ReactNode }) {
  const catalog = useContext(Catalog);
  const provider = model === null ? undefined : catalog?.get(model);
  const className = "mt-px size-3.5 shrink-0";
  return (
    <span className="flex min-w-0 max-w-full items-start gap-1 normal-case">
      {provider
        ? <ProviderIcon providerKind="agent" provider={provider} fallback="Bot" className={className} aria-hidden />
        : <Icon name={model === null ? "Layers" : "Bot"} className={className} aria-hidden />}
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
    </span>
  );
}
