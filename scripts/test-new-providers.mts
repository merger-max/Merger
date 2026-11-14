/**
 * اختبار المزودين الثلاثة الجدد بدون شبكة — fetch وهمي يتحقق من الأشكال المرسلة والردود المحللة.
 * يغطي: تحليل مفتاح Cloudflare، خريطة النسب/المدة لدى Volcengine، حالة Novita،
 * نمط المهام غير المتزامنة لدى ModelScope و Agnes، وتصنيف الأخطاء.
 */
import { cloudflareAdapter } from "../src/lib/providers/cloudflare";
import { volcAdapter } from "../src/lib/providers/volc";
import { novitaAdapter } from "../src/lib/providers/novita";
import { modelscopeAdapter } from "../src/lib/providers/modelscope";
import { agnesAdapter } from "../src/lib/providers/agnes";
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
// 1e) تصنيف الحدود — 429 الذي يذكر quota يجب أن يبقى مؤقتًا وليس نفاد رصيد (تثبيت الإصلاح)
{
  check("CLS: 429 + رسالة quota = temporary", classifyProviderError(429, "Rate limit quota exceeded, retry later") === "temporary");
  check("CLS: 402 = exhausted", classifyProviderError(402, "payment required") === "exhausted");
  check("CLS: 400 + insufficient = exhausted (رصيد بحالة 400)", classifyProviderError(400, "insufficient credit balance") === "exhausted");
  check("CLS: 400 + model not found = provider", classifyProviderError(400, "model does not exist") === "provider");
  check("CLS: 403 = disabled", classifyProviderError(403, "forbidden") === "disabled");
  check("CLS: 500 = temporary", classifyProviderError(500, "internal error") === "temporary");
  // حالة Agnes الفعلية: نفاد الحصة يصل بحالة 403 — يجب exhausted وليس disabled
  check("CLS: 403 + Insufficient user quota = exhausted (حالة Agnes الحقيقية)", classifyProviderError(403, "Insufficient user quota, remaining: ＄0.000000") === "exhausted");
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

/* ============ 4) ModelScope ============ */
console.log("\n🟪 ModelScope API-Inference");
const msInput = (prompt = "a lion") => ({
  prompt,
  params: { __type: "image" },
  providerModel: "Tongyi-MAI/Z-Image-Turbo",
});
// 4a) الإنشاء — الهيدر غير المتزامن والجسم والنقطة
{
  let sentHeaders: any;
  let sentBody: any;
  spy = async (url, init) => {
    check("MS: نقطة الإنشاء", url.endsWith("/v1/images/generations"), url);
    sentHeaders = init?.headers as any;
    sentBody = JSON.parse(init?.body as string);
    return jsonRes(200, { task_id: "ms-task-1", task_status: "PENDING" });
  };
  const r = await modelscopeAdapter.createTask("ms-key", "z-image-turbo", msInput());
  check("MS: task_id مستخرج", r.providerTaskId === "ms-task-1");
  check("MS: X-ModelScope-Async-Mode: true", sentHeaders?.["X-ModelScope-Async-Mode"] === "true", sentHeaders);
  check("MS: Bearer توكن", sentHeaders?.Authorization === "Bearer ms-key");
  check("MS: اسم الموديل يُرسل", sentBody.model === "Tongyi-MAI/Z-Image-Turbo");
  check("MS: prompt يُرسل", sentBody.prompt === "a lion");
}
// 4b) الاستعلام — الحالات الثلاث
{
  spy = async (url) => {
    check("MS: نقطة الاستعلام", url.endsWith("/v1/tasks/ms-task-1"), url);
    return jsonRes(200, { task_status: "RUNNING" });
  };
  const p = await modelscopeAdapter.checkTask("ms-key", "ms-task-1");
  check("MS: RUNNING → processing", p.status === "processing");
  spy = async () => jsonRes(200, { task_status: "SUCCEED", output_images: ["https://ms.example/a.jpg"] });
  const d = await modelscopeAdapter.checkTask("ms-key", "ms-task-1");
  check("MS: SUCCEED → completed بالرابط", d.status === "completed" && d.urls?.[0] === "https://ms.example/a.jpg");
  spy = async () => jsonRes(200, { task_status: "FAILED", message: "content filtered" });
  const f = await modelscopeAdapter.checkTask("ms-key", "ms-task-1");
  check("MS: FAILED → فشل بالسبب", f.status === "failed" && f.error === "content filtered");
}
// 4c) تصنيف الأخطاء — disabled ثم temporary (429 الحصة اليومية)
{
  spy = async () => jsonRes(401, { message: "Invalid token" });
  try {
    await modelscopeAdapter.createTask("bad", "z-image-turbo", msInput());
    check("MS: يجب أن يرمي عند 401", false);
  } catch (err: any) {
    check("MS: 401 → disabled (تعطيل تلقائي)", classifyProviderError(err.status, err.message) === "disabled", { cls: classifyProviderError(err.status, err.message) });
  }
  spy = async () => jsonRes(429, { message: "Too many requests" });
  try {
    await modelscopeAdapter.createTask("k", "z-image-turbo", msInput());
    check("MS: يجب أن يرمي عند 429", false);
  } catch (err: any) {
    check("MS: 429 → temporary (المفتاح يبقى سليمًا)", classifyProviderError(err.status, err.message) === "temporary", { cls: classifyProviderError(err.status, err.message) });
  }
}

/* ============ 5) Agnes AI ============ */
console.log("\n🟧 Agnes AI");
// 5a) صور متزامنة — b64_json ثم url
{
  spy = async (url, init) => {
    check("AGNES: نقطة الصور", url.endsWith("/v1/images/generations"), url);
    const b = JSON.parse(init?.body as string);
    check("AGNES: model الصور يُرسل", b.model === "agnes-image-2.1-flash");
    check("AGNES: n=1", b.n === 1);
    check("AGNES: Bearer مفتاح", (init?.headers as any)?.Authorization === "Bearer agnes-key");
    return jsonRes(200, { data: [{ b64_json: "QUJD" }] });
  };
  const r1 = await agnesAdapter.createImageSync!("agnes-key", {
    prompt: "a bird",
    params: { __type: "image" },
    providerModel: "agnes-image-2.1-flash",
  });
  check("AGNES: b64_json → data URI", r1.urls[0] === "data:image/png;base64,QUJD");
  spy = async () => jsonRes(200, { data: [{ url: "https://agnes.example/a.png" }] });
  const r2 = await agnesAdapter.createImageSync!("agnes-key", {
    prompt: "a bird",
    params: { __type: "image" },
    providerModel: "agnes-image-2.1-flash",
  });
  check("AGNES: url تُمرر كما هي", r2.urls[0] === "https://agnes.example/a.png");
}
// 5b) فيديو — الجسم الكامل: mode إجباري و seconds نصية مقيدة وضغط model داخل المعرف
{
  spy = async (url, init) => {
    check("AGNES: نقطة الفيديو", url.endsWith("/v1/videos"), url);
    const b = JSON.parse(init?.body as string);
    check("AGNES: model الفيديو يُرسل", b.model === "agnes-video-2.5");
    check("AGNES: prompt يُرسل", b.prompt === "waves");
    check("AGNES: mode=text إجباري", b.mode === "text");
    check("AGNES: n=1", b.n === 1);
    check("AGNES: seconds نصية ومقيدة 15→12", b.seconds === "12");
    check("AGNES: 480p → 720P (أدنى مدى مدعوم)", b.size === "720P");
    return jsonRes(200, { video_id: "vid-7" });
  };
  const r = await agnesAdapter.createTask("agnes-key", "agnes-video-2-5", {
    prompt: "waves",
    params: { __type: "video", duration: 15, resolution: "480p" },
    providerModel: "agnes-video-2.5",
  });
  check("AGNES: المعرف بصيغة model@@video_id", r.providerTaskId === "agnes-video-2.5@@vid-7", r.providerTaskId);
}
// 5b-2) صورة كإطار أول → mode=keyframe مع first_frame، وبدون مدة/نسبة تُحذف الحقول
{
  spy = async (_u, init) => {
    const b = JSON.parse(init?.body as string);
    check("AGNES: صورة → mode=keyframe", b.mode === "keyframe");
    check("AGNES: الصورة في first_frame", b.first_frame === "https://x/img.jpg");
    check("AGNES: بلا مدة → لا حقل seconds", b.seconds === undefined);
    check("AGNES: auto → لا حقل aspect_ratio", b.aspect_ratio === undefined);
    return jsonRes(200, { video_id: "vid-8" });
  };
  await agnesAdapter.createTask("agnes-key", "agnes-video-2-5", {
    prompt: "waves",
    params: { __type: "video", aspect_ratio: "auto", image_url: "https://x/img.jpg" },
    providerModel: "agnes-video-2.5",
  });
}
// 5c) الاستعلام — يفك model_name من المعرف ويحلل الحالات
{
  spy = async (url) => {
    check("AGNES: نقطة الاستعلام بالباراميترين", url.endsWith("/agnesapi?video_id=vid-7&model_name=agnes-video-2.5"), url);
    return jsonRes(200, { status: "processing", progress: 55 });
  };
  const p = await agnesAdapter.checkTask("agnes-key", "agnes-video-2.5@@vid-7");
  check("AGNES: processing بتقدم 55%", p.status === "processing" && p.progress === 55);
  spy = async () => jsonRes(200, { status: "completed", video_url: "https://agnes.example/v.mp4" });
  const d = await agnesAdapter.checkTask("agnes-key", "agnes-video-2.5@@vid-7");
  check("AGNES: completed → completed بالرابط", d.status === "completed" && d.urls?.[0] === "https://agnes.example/v.mp4");
  spy = async () => jsonRes(200, { status: "failed", message: "policy" });
  const f = await agnesAdapter.checkTask("agnes-key", "agnes-video-2.5@@vid-7");
  check("AGNES: failed → فشل بالسبب", f.status === "failed" && f.error === "policy");
}
// 5d) مفتاح خاطئ → disabled
{
  spy = async () => jsonRes(401, { message: "invalid api key" });
  try {
    await agnesAdapter.createTask("bad", "agnes-video-2-5", { prompt: "x", params: {}, providerModel: "agnes-video-2.5" });
    check("AGNES: يجب أن يرمي عند 401", false);
  } catch (err: any) {
    check("AGNES: 401 → disabled (تعطيل تلقائي)", classifyProviderError(err.status, err.message) === "disabled", { cls: classifyProviderError(err.status, err.message) });
  }
}

/* ============ 6) سجل الموديلات ============ */
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
  const zi = resolveModel("z-image-turbo");
  check("MODELS: z-image-turbo (modelscope فقط)", !!zi && zi.type === "image" && zi.providers.length === 1 && zi.providers[0] === "modelscope");
  const aimg = resolveModel("agnes-image-2.1-flash");
  check("MODELS: agnes-image alias يُوحد لـ agnes-image-2-1-flash", !!aimg && aimg.canonical === "agnes-image-2-1-flash" && aimg.providers[0] === "agnes");
  const avid = resolveModel("agnes-video-2-5-flash");
  check("MODELS: agnes-video-2-5-flash (agnes فقط)", !!avid && avid.type === "video" && avid.providers.length === 1 && avid.providers[0] === "agnes");
  const afid = resolveModel("agnes-video-2.5");
  check("MODELS: agnes-video-2.5 alias يعمل", !!afid && afid.canonical === "agnes-video-2-5");
}

/* ============ الخلاصة ============ */
globalThis.fetch = realFetch;
console.log(`\n========================================`);
console.log(`النتيجة: ${pass} نجاح / ${fail} فشل`);
process.exit(fail > 0 ? 1 : 0);
