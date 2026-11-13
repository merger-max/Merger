/**
 * منسّق التوليد والدمج — قلب التدفق الكامل.
 *
 * القواعد الذهبية المنفذة هنا:
 *  1) روابط فقط — لا تنزيل أي وسائط إلى السيرفر أبدًا.
 *  2) المفاتيح تُجرَّب بترتيب إضافتها التسلسلي الصارم (ليس round-robin).
 *  3) التبديل التلقائي الفوري عند أي خطأ/نفاد رصيد دون توقف المهمة —
 *     نفس المهمة بنفس task_id تُستأنف على المفتاح التالي.
 *  4) نموذج الذكاء الاصطناعي لا يرى أخطاء المفاتيح أو الرصيد أبدًا (تعقيم كل الرسائل).
 *  5) مهمة فشل إنشاؤها على كل المفاتيح تبقى processing وتُعاد مع كل get_task (تهدئة ~45 ثانية).
 *  6) أخطاء خدمة الدمج المعلنة (HTTP 4xx/5xx بجسم error) = فشل حتمي فوري؛ أخطاء شبكتنا = مؤقتة.
 */
import { randomUUID } from "node:crypto";
import {
  getTask,
  getApiKey,
  insertTask,
  updateTask,
  type AttemptEntry,
  type ApiKeyRow,
  type TaskRow,
} from "./turso";
import {
  attemptEntry,
  classifyException,
  classifyProviderError,
  isKeyRelatedFailure,
  ProviderError,
  recordKeyAttempt,
  type ErrorClass,
} from "./keys";
import { getAdapter, type GenerateTaskInput } from "./providers";
import { resolveModel, MERGE_MODEL, type ModelDef } from "./models";
import { mergerClient } from "./merger";

const POLL_INTERVAL_MS = 3_000; // استعلام كل 3 ثوانٍ أثناء نافذة الانتظار
const KEY_RETRY_COOLDOWN_MS = 45_000; // تهدئة قبل إعادة محاولة الإنشاء على get_task
const PROCESS_IN_FLIGHT = new Set<string>(); // قفل الذاكرة لعملية الدمج process
const PROCESSED_ONCE = new Set<string>(); // منع تنفيذ process أكثر من مرة

export type ProgressCallback = (progress: number, message: string) => Promise<void> | void;

export interface GenerateParams {
  type: "image" | "video";
  model: string;
  prompt: string;
  params: Record<string, unknown>;
  waitSeconds: number;
  onProgress?: ProgressCallback;
}

export type GenerationOutcome =
  | { kind: "no_keys"; model: string }
  | { kind: "task"; task: TaskRow };

/* ==================== الإنشاء على المفاتيح بالترتيب ==================== */

interface CreateOutcome {
  ok: boolean;
  reason?: "exhausted_all" | "params";
  error?: string;
  syncUrls?: string[];
  usedKey?: ApiKeyRow;
}

/**
 * جرّب المرشحين بالترتيب بدءًا من startIdx — أول نجاح يربط المهمة بالمزود والمفتاح.
 * كل محاولة (نجاح أو فشل + الفئة) تُسجَّل في attempts_json وعدّادات المفتاح تُحدَّث دائمًا.
 */
async function createOnCandidates(
  taskId: string,
  modelDef: ModelDef,
  candidates: ApiKeyRow[],
  startIdx: number,
  prompt: string,
  params: Record<string, unknown>,
): Promise<CreateOutcome> {
  for (let i = Math.max(0, startIdx); i < candidates.length; i++) {
    const key = candidates[i];
    const adapter = getAdapter(key.provider as any);
    const input: GenerateTaskInput = {
      prompt,
      params: { ...params, __type: modelDef.type },
      providerModel: modelDef.providerModel[key.provider as "kie" | "cometapi"],
    };
    try {
      // صور CometAPI متزامنة — تعيد الروابط فورًا
      if (modelDef.type === "image" && adapter.createImageSync) {
        const { urls } = await adapter.createImageSync(key.api_key, input);
        await recordKeyAttempt({ key, ok: true });
        await recordAttempt(taskId, key, true);
        await updateTask(taskId, {
          provider: key.provider,
          key_id: key.id,
          status: "processing",
        });
        return { ok: true, syncUrls: urls, usedKey: key };
      }
      const { providerTaskId } = await adapter.createTask(key.api_key, modelDef.canonical, input);
      await recordKeyAttempt({ key, ok: true });
      await recordAttempt(taskId, key, true);
      await updateTask(taskId, {
        provider: key.provider,
        provider_task_id: providerTaskId,
        key_id: key.id,
        status: "processing",
        reset_error: true,
      });
      return { ok: true, usedKey: key };
    } catch (err) {
      const cls = classifyException(err);
      const msg = err instanceof Error ? err.message : String(err);
      await recordKeyAttempt({ key, ok: false, errorClass: cls, error: msg });
      await recordAttempt(taskId, key, false, cls, msg);
      if (cls === "params") {
        // توقف فورًا — تبديل المفاتيح لن يحل خطأ معطيات
        await updateTask(taskId, { status: "failed", error_message: sanitizeError(msg) });
        return { ok: false, reason: "params", error: msg };
      }
      // disabled/exhausted/provider/temporary → انتقل للمفتاح التالي
      continue;
    }
  }
  // فشل الإنشاء على كل المفاتيح — المهمة تبقى processing «بانتظار توفر مفتاح صالح…»
  return { ok: false, reason: "exhausted_all" };
}

async function recordAttempt(
  taskId: string,
  key: ApiKeyRow,
  ok: boolean,
  errorClass?: ErrorClass,
  error?: string,
): Promise<void> {
  await updateTask(taskId, {
    new_attempt: attemptEntry({ key, ok, errorClass, error }),
  });
}

/* ==================== التعقيم: لا تسريب مفاتيح/رصيد للعميل ==================== */

export function sanitizeError(error: string | null | undefined): string {
  if (!error) return "خطأ غير معروف";
  if (isKeyRelatedFailure(error)) {
    return "تعذر إكمال المهمة على المزود — ستُعاد المحاولة تلقائيًا؛ جرّب مجددًا بعد قليل";
  }
  return String(error).slice(0, 500);
}

/* ==================== runGeneration ==================== */

export async function runGeneration(opts: GenerateParams): Promise<GenerationOutcome> {
  // 1) توحيد اسم الموديل — غير معروف → خطأ معطيات فوري
  const modelDef = resolveModel(opts.model);
  if (!modelDef) {
    throw new Error(
      `موديل غير معروف: ${opts.model}. المتاح: gpt-image-2-6/flare-text-to-image (صور)، grok-imagine-video-1-5-preview (فيديو)`,
    );
  }

  // 2) تجمع المرشحين بالترتيب — فارغ → رد no_keys بالرسالة العربية المحددة
  const { getKeyPool } = await import("./turso");
  const candidates = await getKeyPool(modelDef.providers);
  if (!candidates.length) {
    return { kind: "no_keys", model: modelDef.canonical };
  }

  // 3) سجّل المهمة في Turso قبل أي نداء خارجي (تظل قابلة للتتبع حتى لو انقطع الاتصال)
  const taskId = randomUUID();
  await insertTask({
    id: taskId,
    model: modelDef.canonical,
    type: modelDef.type,
    prompt: opts.prompt,
    params_json: JSON.stringify({ ...opts.params, model_input: opts.model }),
    status: "pending",
    progress: 0,
  });

  const create = await createOnCandidates(taskId, modelDef, candidates, 0, opts.prompt, opts.params);
  if (!create.ok) {
    if (create.reason === "params") {
      const t = await getTask(taskId);
      return { kind: "task", task: t! };
    }
    // exhausted_all → تبقى processing برسالة داخلية، وتُعاد المحاولة مع كل get_task
    await updateTask(taskId, {
      error_message: "بانتظار توفر مفتاح صالح…",
    });
    const t = await getTask(taskId);
    return { kind: "task", task: t! };
  }

  // صور متزامنة — اكتملت فورًا
  if (create.syncUrls) {
    await updateTask(taskId, {
      status: "completed",
      progress: 100,
      result_urls: create.syncUrls,
      error_message: null,
    });
    const t = await getTask(taskId);
    return { kind: "task", task: t! };
  }

  // 4-5) نافذة الانتظار: استعلام كل 3 ثوانٍ مع بث التقدم
  const task = await waitForTask(taskId, modelDef, candidates, opts, opts.onProgress);
  return { kind: "task", task };
}

/** نافذة الانتظار للاستعلام — تشمل التبديل في منتصف المهمة بنفس task_id */
async function waitForTask(
  taskId: string,
  modelDef: ModelDef,
  candidates: ApiKeyRow[],
  opts: { waitSeconds: number; onProgress?: ProgressCallback },
  onProgress?: ProgressCallback,
  startIdx = 0,
): Promise<TaskRow> {
  const deadline = Date.now() + opts.waitSeconds * 1000;
  let lastProgress = -1;
  let lastIdx = startIdx;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const t = await getTask(taskId);
    if (!t) break;
    if (t.status === "completed" || t.status === "failed") return t;
    if (!t.provider_task_id || !t.provider) {
      // الإنشاء لم ينجز بعد (نادر) — نخرج ليعيد get_task المحاولة
      break;
    }

    const adapter = getAdapter(t.provider as any);
    try {
      const check = await adapter.checkTask(t.key_id ? ((await getApiKey(t.key_id))?.api_key ?? "") : "", t.provider_task_id);
      if (check.status === "completed" && check.urls?.length) {
        await updateTask(taskId, {
          status: "completed",
          progress: 100,
          result_urls: check.urls,
          error_message: null,
        });
        return (await getTask(taskId))!;
      }
      if (check.status === "failed") {
        // فشل حقيقي؟ التمييز: فشل مفتاح/رصيد → تبديل بنفس task_id؛ فشل معطيات/سياسة → failed نهائي
        if (isKeyRelatedFailure(check.error)) {
          const switched = await switchMidTask(taskId, modelDef, candidates, lastIdx + 1, opts);
          if (switched) {
            lastIdx = switched.idx;
            continue;
          }
          await updateTask(taskId, { error_message: "بانتظار توفر مفتاح صالح…" });
          break; // لا مفاتيح أكثر — تبقى processing وتُستأنف مع get_task
        }
        await updateTask(taskId, {
          status: "failed",
          error_message: sanitizeError(check.error),
        });
        return (await getTask(taskId))!;
      }
      // جارية — اكتب التقدم فورًا في Turso وبثّه
      if (typeof check.progress === "number" && check.progress !== lastProgress) {
        lastProgress = check.progress;
        await updateTask(taskId, { progress: check.progress });
        await onProgress?.(check.progress, `قيد التوليد… ${check.progress}%`);
      }
    } catch (err) {
      const cls = classifyException(err);
      if (cls === "disabled" || cls === "exhausted") {
        // المفتاح مات أثناء المهمة → تبديل فوري بنفس task_id (العميل لا يرى شيئًا)
        const switched = await switchMidTask(taskId, modelDef, candidates, lastIdx + 1, opts);
        if (switched) {
          lastIdx = switched.idx;
          continue;
        }
        await updateTask(taskId, { error_message: "بانتظار توفر مفتاح صالح…" });
        break;
      }
      // temporary (429/5xx/شبكة) → استمر بالاستعلام حتى انتهاء النافذة
      continue;
    }
  }

  // انتهت النافذة والنتيجة لم تظهر → أعد المهمة بحالة processing والعميل يتابع بـ get_task
  const t = await getTask(taskId);
  return t!;
}

/** إعادة إنشاء نفس المهمة بنفس task_id على المفتاح التالي — صامتة تمامًا عن العميل */
async function switchMidTask(
  taskId: string,
  modelDef: ModelDef,
  candidates: ApiKeyRow[],
  startIdx: number,
  opts: { waitSeconds: number },
): Promise<{ idx: number } | null> {
  const t = await getTask(taskId);
  if (!t) return null;
  const create = await createOnCandidates(
    taskId,
    modelDef,
    candidates,
    startIdx,
    t.prompt,
    { ...(JSON.parse(t.params_json || "{}") as Record<string, unknown>), __type: modelDef.type },
  );
  if (!create.ok) return null;
  return { idx: startIdx };
}

/* ==================== refreshTask (get_task) ==================== */

export interface RefreshResult {
  task: TaskRow;
  message: string;
}

export async function refreshTask(taskId: string): Promise<RefreshResult | null> {
  let task = await getTask(taskId);
  if (!task) return null;

  if (task.status === "completed" || task.status === "failed") {
    return { task, message: formatTaskMessage(task) };
  }

  if (task.type === "merge") {
    task = await refreshMergeTask(task);
    return { task, message: formatTaskMessage(task) };
  }

  const modelDef = resolveModel(task.model) ?? {
    canonical: task.model,
    aliases: [],
    type: task.type as "image" | "video",
    providers: ["kie"] as any[],
    providerModel: { kie: task.model, cometapi: task.model },
  } as ModelDef;

  const { getKeyPool } = await import("./turso");
  const candidates = await getKeyPool(modelDef.providers);

  if (!task.provider_task_id || !task.provider) {
    // الإنشاء لم ينجح على أي مفتاح — أعد المحاولة مع تهدئة ~45 ثانية حتى لا نضغط المزودين
    const lastAttempt = lastAttemptTime(task);
    if (Date.now() - lastAttempt < KEY_RETRY_COOLDOWN_MS) {
      return { task, message: formatTaskMessage(task) };
    }
    const create = await createOnCandidates(taskId, modelDef, candidates, 0, task.prompt, safeParams(task));
    if (!create.ok) {
      await updateTask(taskId, { error_message: "بانتظار توفر مفتاح صالح…" });
      task = (await getTask(taskId))!;
      return { task, message: formatTaskMessage(task) };
    }
    if (create.syncUrls) {
      await updateTask(taskId, {
        status: "completed",
        progress: 100,
        result_urls: create.syncUrls,
        error_message: null,
      });
      task = (await getTask(taskId))!;
      return { task, message: formatTaskMessage(task) };
    }
    // نجح الإنشاء — استعلام سريع واحد قد يكمل فورًا
    task = (await getTask(taskId))!;
  }

  // المهمة جارية لدى المزود — حدّثها حية
  const adapter = getAdapter(task.provider as any);
  const key = task.key_id ? await getApiKey(task.key_id) : null;
  try {
    const check = await adapter.checkTask(key?.api_key ?? "", task.provider_task_id!);
    if (check.status === "completed" && check.urls?.length) {
      await updateTask(task.id, {
        status: "completed",
        progress: 100,
        result_urls: check.urls,
        error_message: null,
      });
    } else if (check.status === "failed") {
      if (isKeyRelatedFailure(check.error)) {
        // فشل مفتاح/رصيد في منتصف المهمة → تبديل بنفس task_id ثم استعلام سريع
        const idx = candidates.findIndex((k) => k.id === task!.key_id);
        const switched = await switchMidTask(task.id, modelDef, candidates, Math.max(0, idx) + 1, { waitSeconds: 0 });
        if (switched) {
          task = (await getTask(task.id))!;
          const t2 = await quickCheck(task, modelDef, candidates);
          task = t2;
        } else {
          await updateTask(task.id, { error_message: "بانتظار توفر مفتاح صالح…" });
          task = (await getTask(task.id))!;
        }
      } else {
        await updateTask(task.id, {
          status: "failed",
          error_message: sanitizeError(check.error),
        });
      }
    } else if (typeof check.progress === "number") {
      await updateTask(task.id, { progress: check.progress });
    }
  } catch (err) {
    const cls = classifyException(err);
    if (cls === "disabled" || cls === "exhausted") {
      const idx = candidates.findIndex((k) => k.id === task!.key_id);
      const switched = await switchMidTask(task.id, modelDef, candidates, Math.max(0, idx) + 1, { waitSeconds: 0 });
      if (switched) {
        task = (await getTask(task.id))!;
        task = await quickCheck(task, modelDef, candidates);
      } else {
        await updateTask(task.id, { error_message: "بانتظار توفر مفتاح صالح…" });
        task = (await getTask(task.id))!;
      }
    }
    // temporary → أعد الحالة الحالية كما هي
  }

  task = (await getTask(task.id))!;
  return { task, message: formatTaskMessage(task) };
}

/** استعلام واحد سريع بعد إنشاء ناجح — يكمل فورًا إن كانت النتيجة جاهزة */
async function quickCheck(task: TaskRow, modelDef: ModelDef, candidates: ApiKeyRow[]): Promise<TaskRow> {
  if (task.status !== "processing" || !task.provider_task_id) return task;
  const adapter = getAdapter(task.provider as any);
  const key = task.key_id ? await getApiKey(task.key_id) : null;
  try {
    const check = await adapter.checkTask(key?.api_key ?? "", task.provider_task_id);
    if (check.status === "completed" && check.urls?.length) {
      await updateTask(task.id, {
        status: "completed",
        progress: 100,
        result_urls: check.urls,
        error_message: null,
      });
      return (await getTask(task.id))!;
    }
    if (check.status === "failed" && !isKeyRelatedFailure(check.error)) {
      await updateTask(task.id, { status: "failed", error_message: sanitizeError(check.error) });
      return (await getTask(task.id))!;
    }
    if (typeof check.progress === "number") {
      await updateTask(task.id, { progress: check.progress });
    }
  } catch {
    // مؤقت — يتابعها get_task التالي
  }
  return (await getTask(task.id))!;
}

function lastAttemptTime(task: TaskRow): number {
  try {
    const attempts = JSON.parse(task.attempts_json || "[]") as AttemptEntry[];
    if (attempts.length) {
      const times = attempts.map((a) => Date.parse(a.at)).filter((n) => Number.isFinite(n));
      if (times.length) return Math.max(...times);
    }
  } catch { /* تجاهل */ }
  return Date.parse(task.updated_at) || 0;
}

function safeParams(task: TaskRow): Record<string, unknown> {
  try {
    return JSON.parse(task.params_json || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

/* ==================== runMerge ==================== */

export interface MergeParams {
  urls?: string[];
  taskIds?: string[];
  waitSeconds: number;
  onProgress?: ProgressCallback;
}

export type MergeOutcome =
  | { kind: "invalid"; message: string }
  | { kind: "task"; task: TaskRow };

/** تدفق الدمج — تحقق صارم ثم إنشاء ثم process مرة واحدة مع بث تقدم */
export async function runMerge(opts: MergeParams): Promise<MergeOutcome> {
  // 1) حلل task_ids (لمهام فيديو مكتملة) بالترتيب — أولاً ثم الروابط المباشرة
  const resolvedUrls: string[] = [];
  const failures: string[] = [];
  for (const tid of opts.taskIds ?? []) {
    const t = await getTask(String(tid).trim());
    if (!t) {
      failures.push(`المهمة ${tid}: غير موجودة`);
      continue;
    }
    if (t.status !== "completed") {
      failures.push(`المهمة ${tid}: الحالة ${t.status} وليست completed`);
      continue;
    }
    const urls = JSON.parse(t.result_urls_json || "[]") as string[];
    if (!urls.length) {
      failures.push(`المهمة ${tid}: بلا روابط نتائج`);
      continue;
    }
    resolvedUrls.push(...urls);
  }
  if (failures.length) {
    return {
      kind: "invalid",
      message: `❌ تعذر حل بعض المهام:\n- ${failures.join("\n- ")}\n\nأكمل توليدها أولًا (get_task) ثم أعد الدمج.`,
    };
  }
  const allUrls = [...resolvedUrls, ...(opts.urls ?? []).map((u) => String(u).trim())];

  // 2) تحقق صارم
  if (allUrls.length < 2) {
    return {
      kind: "invalid",
      message:
        "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.",
    };
  }
  if (allUrls.length > 10) {
    return {
      kind: "invalid",
      message: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).",
    };
  }
  const badUrl = allUrls.find((u) => !/^https?:\/\/.+/i.test(u));
  if (badUrl) {
    return {
      kind: "invalid",
      message: `❌ كل المقاطع يجب أن تكون روابط فيديو مباشرة عامة (http/https). رابط غير صالح: ${badUrl.slice(0, 80)}`,
    };
  }

  // 3) سجّل المهمة أولًا
  const taskId = randomUUID();
  await insertTask({
    id: taskId,
    provider: "merger",
    model: MERGE_MODEL,
    type: "merge",
    prompt: `دمج ${allUrls.length} مقاطع`,
    params_json: JSON.stringify({ videos: allUrls }),
    status: "pending",
    progress: 0,
  });

  try {
    const job = await mergerClient.createJob(allUrls);
    await updateTask(taskId, {
      provider_task_id: job.jobId,
      status: "processing",
      progress: 0,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const cls = classifyProviderError(
      err instanceof ProviderError ? err.status : null,
      msg,
    );
    if (cls === "temporary") {
      // خطأ شبكتنا — تبقى processing وتُعاد مع get_task (تهدئة)
      await updateTask(taskId, {
        error_message: "بانتظار جهوزية خدمة الدمج… (سيُعاد الإنشاء تلقائيًا)",
      });
    } else {
      // خطأ معلن من الخدمة = فشل حتمي فوري — لا إعادة محاولة
      await updateTask(taskId, { status: "failed", error_message: sanitizeMergeError(msg) });
    }
    const t = await getTask(taskId);
    return { kind: "task", task: t! };
  }

  // 4) أطلق process مرة واحدة فقط بقفل في الذاكرة
  fireProcessOnce(taskId);

  // 5) نافذة الانتظار: استعلام كل 3 ثوانٍ مع كتابة التقدم فورًا وبثّه
  const deadline = Date.now() + opts.waitSeconds * 1000;
  let lastProgress = -1;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const t = await getTask(taskId);
    if (!t || t.status === "completed" || t.status === "failed") break;
    if (!t.provider_task_id) break;
    let st;
    try {
      st = await mergerClient.getJob(t.provider_task_id);
    } catch (err: any) {
      if (err instanceof ProviderError && err.status === 404) {
        await updateTask(taskId, {
          status: "failed",
          error_message: "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)",
        });
        break;
      }
      continue; // شبكة مؤقتة — استمر بالاستعلام
    }
    if (st.status === "done" && st.videoUrl) {
      await updateTask(taskId, {
        status: "completed",
        progress: 100,
        result_urls: [st.videoUrl],
        error_message: null,
      });
      break;
    }
    if (st.status === "failed") {
      await updateTask(taskId, {
        status: "failed",
        error_message: sanitizeMergeError(st.error ?? "merge failed"),
      });
      break;
    }
    if (st.progress !== lastProgress) {
      lastProgress = st.progress;
      await updateTask(taskId, { progress: st.progress });
      await opts.onProgress?.(st.progress, `جارٍ الدمج… ${st.progress}%`);
    }
  }

  const t = await getTask(taskId);
  return { kind: "task", task: t! };
}

/** نفّذ process مرة واحدة فقط لكل مهمة (قفل في الذاكرة) */
function fireProcessOnce(taskId: string): void {
  void (async () => {
    const t = await getTask(taskId);
    if (!t?.provider_task_id) return;
    const jobId = t.provider_task_id;
    if (PROCESSED_ONCE.has(jobId) || PROCESS_IN_FLIGHT.has(jobId)) return;
    PROCESS_IN_FLIGHT.add(jobId);
    try {
      await mergerClient.processJob(jobId);
      PROCESSED_ONCE.add(jobId);
    } catch {
      // فشل معلن (4xx/5xx) — استعلام getJob في الحلقة سيلتقط الحالة ويحسمها نهائيًا
    } finally {
      PROCESS_IN_FLIGHT.delete(jobId);
    }
  })();
}

/** رسائل أخطاء الدمج لا تتعلق بمفاتيح أصلًا، لكن نوحّد الشكل */
function sanitizeMergeError(msg: string): string {
  return `فشل الدمج: ${String(msg).slice(0, 400)}`;
}

/* ==================== refreshMergeTask (get_task للدمج) ==================== */

async function refreshMergeTask(task: TaskRow): Promise<TaskRow> {
  // بلا jobId — الإنشاء لم يتم (خطأ شبكة سابق) — أعد المحاولة بتهدئة
  if (!task.provider_task_id) {
    const lastAttempt = lastAttemptTime(task);
    if (Date.now() - lastAttempt < KEY_RETRY_COOLDOWN_MS) return task;
    const videos = (safeParams(task).videos as string[]) ?? [];
    if (videos.length < 2) return task;
    try {
      const job = await mergerClient.createJob(videos);
      await updateTask(task.id, {
        provider_task_id: job.jobId,
        status: "processing",
        error_message: null,
      });
      fireProcessOnce(task.id);
      return (await getTask(task.id))!;
    } catch (err: any) {
      const cls = classifyProviderError(err instanceof ProviderError ? err.status : null, String(err?.message ?? err));
      if (cls !== "temporary") {
        await updateTask(task.id, {
          status: "failed",
          error_message: sanitizeMergeError(String(err?.message ?? err)),
        });
      }
      return (await getTask(task.id))!;
    }
  }

  const jobId = task.provider_task_id;
  let st;
  try {
    st = await mergerClient.getJob(jobId);
  } catch (err: any) {
    if (err instanceof ProviderError && err.status === 404) {
      await updateTask(task.id, {
        status: "failed",
        error_message: "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)",
      });
      return (await getTask(task.id))!;
    }
    return task; // شبكة مؤقتة — الحالة كما هي
  }

  if (st.status === "done" && st.videoUrl) {
    await updateTask(task.id, {
      status: "completed",
      progress: 100,
      result_urls: [st.videoUrl],
      error_message: null,
    });
    return (await getTask(task.id))!;
  }
  if (st.status === "failed") {
    await updateTask(task.id, {
      status: "failed",
      error_message: sanitizeMergeError(st.error ?? "merge failed"),
    });
    return (await getTask(task.id))!;
  }

  // جارية ولم يُنفَّذ process بعد — نفّذه الآن (محمي بالقفل)
  fireProcessOnce(task.id);
  if (st.progress !== task.progress) {
    await updateTask(task.id, { progress: st.progress });
  }
  return (await getTask(task.id))!;
}

/* ==================== الصياغة العربية الجاهزة للعرض ==================== */

export function formatTaskMessage(task: TaskRow): string {
  const urls = (() => {
    try {
      return (JSON.parse(task.result_urls_json || "[]") as string[]) ?? [];
    } catch {
      return [];
    }
  })();

  if (task.status === "completed") {
    if (task.type === "image") {
      const url = urls[0] ?? "";
      return `✅ تم توليد الصورة بنجاح\n\n![image](${url})\n\nالرابط المباشر: ${url}`;
    }
    if (task.type === "video") {
      return `✅ تم توليد الفيديو بنجاح\n\nالروابط المباشرة:\n${urls.map((u) => `- ${u}`).join("\n")}`;
    }
    return `✅ تم دمج المقاطع بنجاح\n\nالروابط المباشرة:\n${urls
      .map((u) => `- ${u}`)
      .join("\n")}\n\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`;
  }

  if (task.status === "failed") {
    return `❌ فشلت المهمة: ${sanitizeError(task.error_message)}`;
  }

  // processing / pending
  const pct = task.progress > 0 ? ` (${task.progress}%)` : "";
  const note =
    task.error_message === "بانتظار توفر مفتاح صالح…" ||
    task.error_message === "بانتظار جهوزية خدمة الدمج… (سيُعاد الإنشاء تلقائيًا)"
      ? `\n${task.error_message}`
      : "";
  const typeLabel =
    task.type === "image" ? "توليد الصورة" : task.type === "video" ? "توليد الفيديو" : "دمج المقاطع";
  return `⏳ مهمة ${typeLabel} قيد المعالجة${pct} — task_id: ${task.id}\n${note}تابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
