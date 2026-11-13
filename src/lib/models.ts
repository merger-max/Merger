/**
 * سجل الموديلات — الأسماء القياسية، الصيغ البديلة المقبولة، والمزودون القادرون على خدمة كل موديل.
 * الأسماء قابلة للتجاوز بمتغيرات البيئة (KIE_IMAGE_MODEL, KIE_VIDEO_MODEL, COMETAPI_IMAGE_MODEL, COMETAPI_VIDEO_MODEL).
 */

export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  canonical: string; // الاسم كما يراه عميل MCP
  aliases: string[]; // صيغ بديلة نقبلها ونوحّدها (شرطات/نقاط)
  type: MediaType;
  providers: ProviderId[]; // من يستطيع خدمته — تُجرَّب مفاتيحهم كلها بالترتيب
  providerModel: Record<ProviderId, string>; // اسم الموديل كما يُرسل لكل مزود
}

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

export const MODELS: ModelDef[] = [
  {
    canonical: "gpt-image-2-6/flare-text-to-image",
    aliases: ["gpt-image-2.6/flare-text-to-image"],
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: {
      // الأسماء الحقيقية المقاسة من GET /api/v1/models لدى kie.ai — بالشرطات
      kie: env("KIE_IMAGE_MODEL", "gpt-image-2-6/flare-text-to-image"),
      cometapi: env("COMETAPI_IMAGE_MODEL", "gpt-image-2.6-flare-text-to-image"),
    },
  },
  {
    canonical: "grok-imagine-video-1-5-preview",
    aliases: ["grok-imagine-video-1.5-preview"],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: {
      // الأسماء الحقيقية المقاسة من GET /api/v1/models لدى kie.ai — بالشرطات
      kie: env("KIE_VIDEO_MODEL", "grok-imagine-video-1-5-preview"),
      cometapi: env("COMETAPI_VIDEO_MODEL", "grok-imagine-video-1.5-preview"),
    },
  },
];

/** توحيد اسم الموديل — يقبل الصيغ بالنقاط/الشرطات ويعيد التعريف القياسي أو null */
export function resolveModel(input: string | undefined | null): ModelDef | null {
  if (!input) return null;
  const raw = String(input).trim().toLowerCase();
  for (const m of MODELS) {
    if (m.canonical.toLowerCase() === raw) return m;
    if (m.aliases.some((a) => a.toLowerCase() === raw)) return m;
  }
  // توحيد إضافي: تطبيع النقاط↔الشرطات داخل الجزء الأول (قبل /) وبين الأرقام
  const normalized = raw.replace(/(\d)[._](\d)/g, "$1-$2");
  for (const m of MODELS) {
    if (m.canonical.toLowerCase() === normalized) return m;
    if (m.aliases.some((a) => a.toLowerCase() === normalized)) return m;
  }
  return null;
}

export function listModelSummaries() {
  return MODELS.map((m) => ({
    canonical: m.canonical,
    type: m.type,
    providers: m.providers,
  }));
}

/** موديل خدمة الدمج كما يُسجَّل في قاعدة البيانات */
export const MERGE_MODEL = "video-merger";
