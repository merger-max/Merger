/**
 * سجل المزودات — نقطة الوصول الموحدة للـ adapters حسب provider id.
 */
import { kieAdapter } from "./kie";
import { cometApiAdapter } from "./cometapi";
import type { ProviderAdapter, ProviderId } from "./types";

export const PROVIDERS: Record<ProviderId, ProviderAdapter> = {
  kie: kieAdapter,
  cometapi: cometApiAdapter,
};

export function getAdapter(provider: ProviderId): ProviderAdapter {
  const a = PROVIDERS[provider];
  if (!a) throw new Error(`مزود غير معروف: ${provider}`);
  return a;
}

export * from "./types";
