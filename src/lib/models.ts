/**
 * سجل الموديلات — الأسماء القياسية، الصيغ البديلة المقبولة، والمزودون القادرون على خدمة كل موديل.
 * الأسماء قابلة للتجاوز بمتغيرات البيئة (KIE_IMAGE_MODEL, KIE_VIDEO_MODEL, COMETAPI_IMAGE_MODEL,
 * COMETAPI_VIDEO_MODEL, CF_IMAGE_MODEL, VOLC_VIDEO_MODEL, NOVITA_IMAGE_MODEL,
 * MODELSCOPE_IMAGE_MODEL, AGNES_IMAGE_MODEL, AGNES_VIDEO_MODEL, AGNES_VIDEO_FLASH_MODEL,
 * QWENCLOUD_IMAGE_MODEL, QWENCLOUD_VIDEO_MODEL, QWENCLOUD_REGION).
 * المزودون الثمانية: kie / cometapi / qwencloud (مدفوعون) + cloudflare / volc / novita / modelscope / agnes (مجانيون).
 */

export type ProviderId = "kie" | "cometapi" | "cloudflare" | "volc" | "novita" | "modelscope" | "agnes" | "qwencloud";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  canonical: string; // الاسم كما يراه عميل MCP
  aliases: string[]; // صيغ بديلة نقبلها ونوحّدها (شرطات/نقاط)
  type: MediaType;
  providers: ProviderId[]; // من يستطيع خدمته — تُجرَّب مفاتيحهم كلها بالترتيب
  // اسم الموديل كما يُرسَل لكل مزود — المزودون غير القادرين على خدمة الموديل يُحذفون من هنا
  providerModel: Partial<Record<ProviderId, string>>;
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
  {
    // موديل الصور المجاني — Cloudflare Workers AI (10,000 نيورون يوميًا للأبد) و Novita
    canonical: "flux-1-schnell",
    aliases: ["flux.1-schnell", "flux_1_schnell", "flux-schnell"],
    type: "image",
    providers: ["cloudflare", "novita"],
    providerModel: {
      cloudflare: env("CF_IMAGE_MODEL", "@cf/black-forest-labs/flux-1-schnell"),
      novita: env("NOVITA_IMAGE_MODEL", "flux-1-schnell"),
    },
  },
  {
    // موديل الفيديو المجاني للحصة الترحيبية — Volcengine Ark (ByteDance Seedance)
    canonical: "seedance-1-0-pro",
    aliases: ["seedance-1.0-pro", "seedance-pro"],
    type: "video",
    providers: ["volc"],
    providerModel: {
      volc: env("VOLC_VIDEO_MODEL", "doubao-seedance-1-0-pro-250528"),
    },
  },
  {
    // موديل صور ModelScope المجاني (Alibaba) — 2,000 نداء API يوميًا تتجدد + 200 لكل موديل
    canonical: "z-image-turbo",
    aliases: ["zimage-turbo", "z-image"],
    type: "image",
    providers: ["modelscope"],
    providerModel: {
      modelscope: env("MODELSCOPE_IMAGE_MODEL", "Tongyi-MAI/Z-Image-Turbo"),
    },
  },
  {
    // موديل صور Agnes AI — واجهة OpenAI متوافقة وحصة مجانية للبدء (~20 صورة/دقيقة)
    canonical: "agnes-image-2-1-flash",
    aliases: ["agnes-image-2.1-flash"],
    type: "image",
    providers: ["agnes"],
    providerModel: {
      agnes: env("AGNES_IMAGE_MODEL", "agnes-image-2.1-flash"),
    },
  },
  {
    // موديل فيديو Agnes AI — 4–12 ثانية بدقات 720P/1080P/2K
    canonical: "agnes-video-2-5",
    aliases: ["agnes-video-2.5"],
    type: "video",
    providers: ["agnes"],
    providerModel: {
      agnes: env("AGNES_VIDEO_MODEL", "agnes-video-2.5"),
    },
  },
  {
    // النسخة الأسرع من فيديو Agnes — نفس المدى الزمني
    canonical: "agnes-video-2-5-flash",
    aliases: ["agnes-video-2.5-flash"],
    type: "video",
    providers: ["agnes"],
    providerModel: {
      agnes: env("AGNES_VIDEO_FLASH_MODEL", "agnes-video-2.5-flash"),
    },
  },
  {
    // موديل صور QwenCloud (Alibaba عالميًا — qwencloud.com) — مدفوع بالنداء/اشتراك، توليد متزامن فوري
    canonical: "qwen-image",
    aliases: ["qwenimage"],
    type: "image",
    providers: ["qwencloud"],
    providerModel: {
      qwencloud: env("QWENCLOUD_IMAGE_MODEL", "qwen-image-2.1-turbo"),
    },
  },
  {
    // موديل فيديو QwenCloud (Wan) — مهمة غير متزامنة (X-DashScope-Async)، 2–15 ثانية بدقات حتى 1080P
    canonical: "wan-video",
    aliases: ["wanvideo"],
    type: "video",
    providers: ["qwencloud"],
    providerModel: {
      qwencloud: env("QWENCLOUD_VIDEO_MODEL", "wan2.7-t2v"),
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
