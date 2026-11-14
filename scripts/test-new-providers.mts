/**
 * اختبار المزودين الثلاثة الجدد بدون شبكة — fetch وهمي يتحقق من الأشكال المرسلة والردود المحللة.
 * يغطي: تحليل مفتاح Cloudflare، خريطة النسب/المدة لدى Volcengine، حالة Novita، وتصنيف الأخطاء.
 */
import { cloudflareAdapter } from "../src/lib/providers/cloudflare";
import { volcAdapter } from "../src/lib/providers/volc";
import { novitaAdapter } from "../src/lib/providers/novita";
import { classifyProviderError } from "../src/lib/keys";
import { resolveModel } from "../src/lib/models";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}`, extra !== undefined ? JSON.stringify(extra) : "");
  }
}

type FetchSpy = (url: string, init?: RequestInit) => Promise<Response>;
const realFetch = globalThis.fetch;
let spy: FetchSpy | null = null;
let lastCall: { url: string; init?: RequestInit } | null = null;
globalThis.fetch = ((url: any, init?: any) => {
  lastCall = { url: String(url), init };
  if (!spy) throw new Error("no spy configured");
  return spy(String(url), init);
}) as typeof fetch;

const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/* ============ 1) Cloudflare ============ */
console.log("\n🟦 Cloudflare Workers AI");
const imgInput = (prompt = "a cat") => ({
  prompt,
  params: { __type: "image", aspect_ratio: "16:9", resolution: "4K" },
  providerModel: "@cf/black-forest-labs/flux-1-schnell",
});

// 1a) صيغة account_id:token — مباشرة بدون GET /accounts
spy = async (url, init) => {
  check("CF: endpoint يحتوي معرف الحساب", url.includes("/accounts/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6/ai/run/@cf/black-forest-labs/flux-1-schnell"), url);
  check("CF: Bearer توكن", (init?.headers as any)?.Authorization === "Bearer cf-token");
  return jsonRes(200, { result: { image: "QUJD" }, success: true, errors: [], messages: [] });
};
{
  const r = await cloudflareAdapter.createImageSync!("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6:cf-token", imgInput());
  check("CF: data URI صحيح", r.urls[0] === "data:image/jpeg;base64,QUJD", r.urls);
}
// 1b) توكن فقط — يحلل الحساب تلقائيًا ويخزنه
{
  let sawAccounts = false;
  spy = async (url, init) => {
    if (url.endsWith("/accounts")) {
      sawAccounts = true;
      check("CF: توكن في Authorization", (init?.headers as any)?.Authorization === "Bearer cf-only");
      return jsonRes(200, { result: [{ id: "autoacc1" }], success: true });
    }
    return jsonRes(200, { result: { image: "XYZ" }, success: true });
  };
  const r = await cloudflareAdapter.createImageSync!("cf-only", imgInput());
  check("CF: حلل الحساب تلقائيًا", sawAccounts && r.urls[0] === "data:image/jpeg;base64,XYZ");
  // النداء الثاني يستخدم الكاش — لا /accounts مرة أخرى
  sawAccounts = false;
  await cloudflareAdapter.createImageSync!("cf-only", imgInput("dog"));
  check("CF: كاش الحساب يعمل (بلا /accounts ثانية)", !sawAccounts);
}
// 1c) فشل الحل → خطأ فئة provider (لا يوقف المهمة)
spy = async () => jsonRes(403, { success: false, errors: [{ code: 9109, message: "Unauthorized" }] });
{
  try {
    await cloudflareAdapter.createImageSync!("bad-token", imgInput());
    check("CF: يجب أن يرمي عند فشل الحل", false);
  } catch (err: any) {
    const cls = classifyProviderError(err.status, err.message);
    check("CF: فشل الحل = فئة provider (ينتقل للمفتاح التالي)", cls === "provider", { cls, msg: err.message });
  }
}
// 1d) خطأ مزود حقيقي (مثلاً 429)
spy = async () => jsonRes(429, { success: false, errors: [{ code: 429, message: "Daily allocation exceeded" }] });
{
  try {
    await cloudflareAdapter.createImageSync!("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6:cf-token", imgInput());
    check("CF: يجب أن يرمي عند 429", false);
  } catch (err: any) {
    const cls = classifyProviderError(err.status, err.message);
    check("CF: 429 = فئة temporary", cls === "temporary", { cls });
  }
}

/* ============ 2) Volcengine Seedance ============ */
console.log("\n🟨 Volcengine Ark (Seedance)");
const vidInput = (params: Record<string, unknown>) => ({
  prompt: "Ethan explores a dark warehouse",
  params: { __type: "video", ...params },
  providerModel: "doubao-seedance-1-0-pro-250528",
});

// 2a) الإنشاء — المدة تُقيَّد والنسبة تُحوَّل و image_url يضاف كـ first_frame
{
  let sentBody: any;
  spy = async (url, init) => {
    check("VOLC: نقطة الإنشاء صحيحة", url.endsWith("/api/v3/contents/generations/tasks"), url);
    sentBody = JSON.parse(init?.body as string);
    return jsonRes(200, { id: "cgt-test-1" });
  };
  const r = await volcAdapter.createTask(
    "volc-key",
    "seedance-1-0-pro",
    vidInput({ duration: 15, aspect_ratio: "3:2", resolution: "1080p", image_url: "https://x/img.jpg" }),
  );
  check("VOLC: task id مستخرج", r.providerTaskId === "cgt-test-1");
  check("VOLC: المدة 15 → تقييد إلى 12 (مدى Seedance Pro)", sentBody.duration === 12, sentBody.duration);
  check("VOLC: نسبة 3:2 → 4:3", sentBody.ratio === "4:3", sentBody.ratio);
  check("VOLC: الدقة تُمرر", sentBody.resolution === "1080p");
  check("VOLC: image_url → first_frame", sentBody.content[1]?.type === "image_url" && sentBody.content[1]?.role === "first_frame", sentBody.content[1]);
  check("VOLC: العلامة المائية معطلة", sentBody.watermark === false);
  check("VOLC: اسم الموديل يُرسل كما هو", sentBody.model === "doubao-seedance-1-0-pro-250528");
}
// 2b) ratio: auto → adaptive، والمدة الافتراضية
{
  spy = async (_u, init) => {
    const b = JSON.parse(init?.body as string);
    check("VOLC: auto → adaptive", b.ratio === "adaptive");
    check("VOLC: مدة افتراضية 5", b.duration === 5);
    return jsonRes(200, { id: "cgt-2" });
  };
  await volcAdapter.createTask("k", "seedance-1-0-pro", vidInput({ aspect_ratio: "auto" }));
}
// 2c) حالات الاستعلام
{
  spy = async (url) => {
    check("VOLC: نقطة الاستعلام", url.endsWith("/contents/generations/tasks/cgt-2"), url);
    return jsonRes(200, { status: "running" });
  };
  const proc = await volcAdapter.checkTask("k", "cgt-2");
  check("VOLC: running → processing", proc.status === "processing");

  spy = async () =>
    jsonRes(200, { status: "succeeded", content: { video_url: "https://v.example/final.mp4" } });
  const done = await volcAdapter.checkTask("k", "cgt-2");
  check("VOLC: succeeded → completed بالرابط", done.status === "completed" && done.urls?.[0] === "https://v.example/final.mp4");

  spy = async () => jsonRes(200, { status: "failed", error: { message: "content policy" } });
  const bad = await volcAdapter.checkTask("k", "cgt-2");
  check("VOLC: failed → فشل برسالة", bad.status === "failed" && bad.error === "content policy");
}
// 2d) نفاد الرصيد → exhausted (تبديل تلقائي)
{
  spy = async () => jsonRes(400, { error: { code: "AccountArrearage", message: "Your balance is insufficient, please top up" } });
  try {
    await volcAdapter.createTask("k", "seedance-1-0-pro", vidInput({}));
    check("VOLC: يجب أن يرمي عند نفاد الرصيد", false);
  } catch (err: any) {
    const cls = classifyProviderError(err.status, err.message);
    check("VOLC: رصيد غير كافٍ → exhausted", cls === "exhausted", { cls, msg: err.message });
  }
}

/* ============ 3) Novita ============ */
console.log("\n🟩 Novita AI");
// 3a) الإنشاء — غلاف request و model_name و الأبعاد من aspect_ratio
{
  let sentBody: any;
  spy = async (url, init) => {
    check("NOVITA: نقطة txt2img", url.endsWith("/v3/async/txt2img"), url);
    sentBody = JSON.parse(init?.body as string);
    return jsonRes(200, { task_id: "ntask-9" });
  };
  const r = await novitaAdapter.createTask(
    "novita-key",
    "flux-1-schnell",
    { prompt: "a red fox", params: { __type: "image", aspect_ratio: "16:9" }, providerModel: "flux-1-schnell" },
  );
  check("NOVITA: task_id مستخرج", r.providerTaskId === "ntask-9");
  check("NOVITA: غلاف request موجود", sentBody.request?.prompt === "a red fox");
  check("NOVITA: model_name يُمرر", sentBody.request?.model_name === "flux-1-schnell");
  check("NOVITA: 16:9 → 1024x576", sentBody.request?.width === 1024 && sentBody.request?.height === 576);
  check("NOVITA: صورة واحدة", sentBody.request?.image_num === 1);
  check("NOVITA: نوع jpeg", sentBody.extra?.response_image_type === "jpeg");
}
// 3b) الاستعلام — SUCCEED بصور
{
  spy = async (url) => {
    check("NOVITA: نقطة task-result مع task_id", url.endsWith("/v3/async/task-result?task_id=ntask-9"), url);
    return jsonRes(200, {
      task: { task_id: "ntask-9", status: "TASK_STATUS_SUCCEED" },
      images: [{ image_url: "https://novita.example/a.jpg" }],
      videos: [],
    });
  };
  const r = await novitaAdapter.checkTask("novita-key", "ntask-9");
  check("NOVITA: SUCCEED → completed", r.status === "completed" && r.urls?.[0] === "https://novita.example/a.jpg");
}
// 3c) FAILED برسالة + PROCESSING بتقدم
{
  spy = async () => jsonRes(200, { task: { status: "TASK_STATUS_FAILED", reason: "nsfw blocked" }, images: [] });
  const f = await novitaAdapter.checkTask("novita-key", "ntask-9");
  check("NOVITA: FAILED → فشل بالسبب", f.status === "failed" && f.error === "nsfw blocked");

  spy = async () => jsonRes(200, { task: { status: "TASK_STATUS_PROCESSING", progress_percent: 42 } });
  const p = await novitaAdapter.checkTask("novita-key", "ntask-9");
  check("NOVITA: PROCESSING → processing 42%", p.status === "processing" && p.progress === 42);
}
// 3d) مفتاح خاطئ → disabled
{
  spy = async () => jsonRes(401, { code: 20001, message: "Invalid API key" });
  try {
    await novitaAdapter.createTask("wrong", "flux-1-schnell", { prompt: "x", params: { __type: "image" }, providerModel: "flux-1-schnell" });
    check("NOVITA: يجب أن يرمي عند مفتاح خاطئ", false);
  } catch (err: any) {
    const cls = classifyProviderError(err.status, err.message);
    check("NOVITA: مفتاح خاطئ → disabled (تعطيل تلقائي)", cls === "disabled", { cls });
  }
}

/* ============ 4) سجل الموديلات ============ */
console.log("\n📚 سجل الموديلات");
{
  const flux = resolveModel("flux-1-schnell");
  check("MODELS: flux-1-schnell يُحل", !!flux && flux.type === "image" && flux.providers.includes("cloudflare") && flux.providers.includes("novita"));
  check("MODELS: flux.1-schnell alias يعمل", !!resolveModel("flux.1-schnell"));
  const seed = resolveModel("seedance-1-0-pro");
  check("MODELS: seedance-1-0-pro يُحل (volc فقط)", !!seed && seed.type === "video" && seed.providers.length === 1 && seed.providers[0] === "volc");
  const grok = resolveModel("grok-imagine-video-1-5-preview");
  check("MODELS: grok كما هو (kie+cometapi)", !!grok && grok.providers.length === 2);
  const flare = resolveModel("gpt-image-2-6/flare-text-to-image");
  check("MODELS: flare كما هو", !!flare && flare.providers.length === 2);
}

/* ============ الخلاصة ============ */
globalThis.fetch = realFetch;
console.log(`\n========================================`);
console.log(`النتيجة: ${pass} نجاح / ${fail} فشل`);
process.exit(fail > 0 ? 1 : 0);
