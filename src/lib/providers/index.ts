/**
 * سجل المزودات — نقطة الوصول الموحدة للـ adapters حسب provider id.
 * المزودون الخمسة: kie / cometapi (مدفوعان) + cloudflare (صور مجانية يومية) / volc (فيديو Seedance) / novita (صور).
 */
import { kieAdapter } from "./kie";
import { cometApiAdapter } from "./cometapi";
import { cloudflareAdapter } from "./cloudflare";
import { volcAdapter } from "./volc";
import { novitaAdapter } from "./novita";
import type { ProviderAdapter, ProviderId } from "./types";

export const PROVIDERS: Record<ProviderId, ProviderAdapter> = {
  kie: kieAdapter,
  cometapi: cometApiAdapter,
  cloudflare: cloudflareAdapter,
  volc: volcAdapter,
  novita: novitaAdapter,
};

export function getAdapter(provider: ProviderId): ProviderAdapter {
  const a = PROVIDERS[provider];
  if (!a) throw new Error(`مزود غير معروف: ${provider}`);
  return a;
}

export * from "./types";
