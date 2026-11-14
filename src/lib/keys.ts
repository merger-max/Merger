/**
 * نظام المفاتيح المتسلسلة — قلب المشروع.
 * الترتيب صارم بترتيب الإضافة (created_at ASC, id ASC) — ليس round-robin وليس «الأقل استخدامًا».
 * التصنيف الموحد للأخطاء يقود التبديل التلقائي الصامت بين المفاتيح.
 */
import {
  getKeyPool,
  updateApiKey,
  type ApiKeyRow,
  type AttemptEntry,
} from "./turso";

export type ErrorClass =
  | "disabled"
  | "exhausted"
  | "provider"
  | "params"
  | "temporary";

/** إخفاء المفتاح إلزاميًا في كل الاستجابات والسجلات */
export function maskKey(key: string): string {
  if (key.length <= 10) {
    return key.slice(0, 3) + "••••";
  }
  return key.slice(0, 7) + "••••••••" + key.slice(-4);
}

const DISABLED_PATTERNS =
  /invalid api key|api key invalid|unauthorized|forbidden|authentication|invalid key|incorrect api key|invalid_token|no auth/i;
const EXHAUSTED_PATTERNS =
  /insufficient|quota|balance|credit|out of credits|exhausted|充值|余额|no enough|payment required|欠费/i;
const PROVIDER_PATTERNS = /model not found|unsupported model|not supported|model does not exist|invalid model|unknown model|no such model/i;

/**
 * تصنيف موحد لأخطاء المزود — يحدد الإجراء التالي:
 *  disabled  → المفتاح مرفوض (401/403 أو رسالة توثيق) → تعطيل تلقائي → التالي
 *  temporary → 429 دائمًا مؤقت (حد معدل عابر، حتى لو ذكرت رسالته quota) + 5xx/شبكة → التالي والمفتاح سليم
 *  exhausted → نفاد رصيد حقيقي (402 أو رسالة رصيد — تُفحص بعد 429 وقبل 400) → تعليم exhausted → التالي
 *  provider  → الموديل غير مدعوم لدى هذا المزود → التالي
 *  params    → معطيات الطلب خاطئة → توقف فورًا (تبديل المفاتيح لن يحلها)
 */
export function classifyProviderError(
  status: number | null,
  message: string,
): ErrorClass {
  const msg = (message || "").toLowerCase();

  // 1) المفتاح مرفوض — الحالة أو الرسالة
  if (status === 401 || status === 403 || DISABLED_PATTERNS.test(msg)) {
    return "disabled";
  }
  // 2) 429 = حد معدل عابر دائمًا — يُفحص قبل أنساب الرصيد لأن رسائل الحد عادة تذكر quota/rate limit
  if (status === 429) {
    return "temporary";
  }
  // 3) نفاد الرصيد — قبل فحص 400 لأن بعض المزودين يرسلونه بحالة 400
  if (status === 402 || EXHAUSTED_PATTERNS.test(msg)) {
    return "exhausted";
  }
  // 4) الموديل غير مدعوم لدى المزود
  if (
    PROVIDER_PATTERNS.test(msg) &&
    (status === 400 || status === 404 || status === 422 || status === null)
  ) {
    return "provider";
  }
  // 5) معطيات الطلب
  if (status === 400 || status === 422) {
    return "params";
  }
  // 6) 5xx / شبكة / غير معروف → مؤقت
  if ((status !== null && status >= 500) || status === null) {
    return "temporary";
  }
  // أي شيء آخر غير متوقع — نعامله كمؤقت لنستمر بالمحاولة
  return "temporary";
}

export function classifyException(err: unknown): ErrorClass {
  if (err instanceof ProviderError) {
    return classifyProviderError(err.status, err.message);
  }
  // أخطاء الشبكة/الانقطاع/الانتهاء الزمني → مؤقتة
  return "temporary";
}

/** خطأ مزود بحالة HTTP ورسالة — يمر عبر classifyProviderError */
export class ProviderError extends Error {
  status: number | null;
  constructor(status: number | null, message: string) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

/** خطأ معطيات (من العميل أو المزود) — يوقف كل شيء فورًا */
export class ParamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParamError";
  }
}

/** هل رسالة الفشل في منتصف المهمة تخص مفتاحًا/رصيدًا (يستوجب التبديل)؟ */
export function isKeyRelatedFailure(error: string | undefined | null): boolean {
  if (!error) return false;
  return /insufficient|balance|credit|quota|402|401|unauthorized|exhausted|充值|余额|forbidden/i.test(
    error,
  );
}

/** تحديث عدّادات المفتاح وحالته بعد كل محاولة — يُستدعى دائمًا (نجاح أو فشل) */
export async function recordKeyAttempt(opts: {
  key: ApiKeyRow;
  ok: boolean;
  errorClass?: ErrorClass;
  error?: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const patch: Parameters<typeof updateApiKey>[1] = {
    usage_count_delta: 1,
    last_used_at: now,
    last_checked_at: now,
  };
  if (opts.ok) {
    patch.success_delta = 1;
    patch.last_error = null;
  } else {
    patch.fail_delta = 1;
    patch.last_error = opts.error
      ? `${opts.errorClass}: ${opts.error}`.slice(0, 500)
      : `${opts.errorClass}`;
  }
  // تعليم الحالة تلقائيًا حسب الفئة
  if (!opts.ok && opts.errorClass === "disabled") patch.status = "disabled";
  if (!opts.ok && opts.errorClass === "exhausted") patch.status = "exhausted";
  await updateApiKey(opts.key.id, patch);
}

export function attemptEntry(opts: {
  key: ApiKeyRow;
  ok: boolean;
  errorClass?: ErrorClass;
  error?: string;
}): AttemptEntry {
  return {
    provider: opts.key.provider,
    keyId: opts.key.id,
    keyLabel: opts.key.label || maskKey(opts.key.api_key),
    ok: opts.ok,
    ...(opts.errorClass ? { errorClass: opts.errorClass } : {}),
    ...(opts.error ? { error: String(opts.error).slice(0, 300) } : {}),
    at: new Date().toISOString(),
  };
}

/** جلب المرشحين بالترتيب الصارم — المستنزف يبقى في القائمة، والمعطل فقط يُستبعد */
export async function getOrderedCandidates(
  providers: string[],
): Promise<ApiKeyRow[]> {
  return getKeyPool(providers);
}
