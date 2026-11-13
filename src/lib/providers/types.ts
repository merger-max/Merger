/**
 * واجهة المزودات الموحدة — كل مزود ينفذها ويُرمي ProviderError ليُصنَّف بعد ذلك.
 * ملاحظة: لا تُنزَّل أي وسائط على سيرفرنا أبدًا — روابط النتائج فقط.
 */
import { ProviderError } from "../keys";
import type { ProviderId } from "../models";

export interface GenerateTaskInput {
  prompt: string;
  /** كل معطيات الأداة الأصلية (aspect_ratio, resolution, ...) — تُخزَّن params_json لإعادة الإنشاء عند التبديل */
  params: Record<string, unknown>;
  providerModel: string;
}

export interface ProviderAdapter {
  /** مهمة غير متزامنة (فيديو وبعض الصور): تعيد providerTaskId */
  createTask(key: string, model: string, input: GenerateTaskInput): Promise<{ providerTaskId: string }>;
  /** صور متزامنة إن كان المزود يدعمها (تعيد الروابط فورًا) */
  createImageSync?(key: string, input: GenerateTaskInput): Promise<{ urls: string[] }>;
  /** استعلام حالة مهمة جارية */
  checkTask(
    key: string,
    providerTaskId: string,
  ): Promise<{
    status: "processing" | "completed" | "failed";
    urls?: string[];
    error?: string;
    progress?: number;
  }>;
}

export { ProviderError };
export type { ProviderId };
