/**
 * سجل المزودات — نقطة الوصول الموحدة للـ adapters حسب provider id.
 * المزودون السبعة: kie / cometapi (مدفوعان) + cloudflare / volc / novita / modelscope / agnes (مجانيون).
 */
import { kieAdapter } from "./kie";
import { cometApiAdapter } from "./cometapi";
import { cloudflareAdapter } from "./cloudflare";
import { volcAdapter } from "./volc";
import { novitaAdapter } from "./novita";
import { modelscopeAdapter } from "./modelscope";
import { agnesAdapter } from "./agnes";
import type { ProviderAdapter, ProviderId } from "./types";

export const PROVIDERS: Record<ProviderId, ProviderAdapter> = {
  kie: kieAdapter,
  cometapi: cometApiAdapter,
  cloudflare: cloudflareAdapter,
  volc: volcAdapter,
  novita: novitaAdapter,
  modelscope: modelscopeAdapter,
  agnes: agnesAdapter,
};

export function getAdapter(provider: ProviderId): ProviderAdapter {
  const a = PROVIDERS[provider];
  if (!a) throw new Error(`مزود غير معروف: ${provider}`);
  return a;
}

export * from "./types";
