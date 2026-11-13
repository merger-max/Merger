/**
 * عميل خدمة دمج الفيديو — Video Merger API v2.
 * بلا مفاتيح أو توثيق. العنوان من MERGER_API_BASE.
 * المخرجات: MP4 (H.264 + AAC) — لا resolution/fps، الناتج ثابت.
 * القيود: 10 مقاطع كحد أقصى، 200MB لكل مصدر، 150MB للناتج، 600 ثانية مجموع المدد،
 * وكل الملفات تُحذف تلقائيًا بعد 24 ساعة (expiresAt).
 * قواعد دفاعية: progress قد يأتي كسرًا 0..1، والجسم قد يحتوي error بدون status → عاملها failed.
 */
import { ProviderError } from "./keys";

const TIMEOUT_MS = 150_000; // عملية الدمج نفسها تستغرق ~10-15 ثانية، لكن نتحمل مهلة أطول

export function mergerBase(): string {
  return (process.env.MERGER_API_BASE ?? "").replace(/\/$/, "");
}

export interface MergerJobStatus {
  status: "queued" | "processing" | "done" | "failed";
  progress: number; // 0..100
  videoUrl?: string;
  downloadUrl?: string;
  error?: string;
  expiresAt?: string;
  raw?: unknown;
}

function isOkStatus(s: number): boolean {
  return s >= 200 && s < 300;
}

async function mergerFetch(
  path: string,
  init?: RequestInit,
  timeoutMs = TIMEOUT_MS,
): Promise<{ ok: boolean; status: number; body: any }> {
  let res: Response;
  const base = mergerBase();
  if (!base) {
    throw new ProviderError(null, "MERGER_API_BASE غير مضبوط — خدمة الدمج غير مهيأة");
  }
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (err: any) {
    // أخطاء شبكتنا نحن (timeout/fetch) — مؤقتة، يُميَّز عنها الـ 4xx/5xx المعلنة
    throw new ProviderError(null, `merger network error: ${err?.message ?? String(err)}`);
  }
  let body: any = null;
  try {
    const text = await res.text();
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: `invalid JSON (HTTP ${res.status})` };
  }
  return { ok: isOkStatus(res.status), status: res.status, body };
}

/** تحليل الحالة الدفاعي — أكمل/فشل بمرادفات متعددة، وprogress كسرًا أو عددًا */
const DONE_WORDS = new Set(["done", "completed", "complete", "success", "succeeded", "finished"]);
const FAILED_WORDS = new Set(["error", "failed", "failure", "cancelled", "canceled"]);

export function parseMergerStatus(body: any, jobId: string): MergerJobStatus {
  if (!body || typeof body !== "object") {
    return { status: "failed", progress: 0, error: "invalid merger response" };
  }
  // جسم فيه error بدون status → failed فورًا (شكل حقيقي مقاس)
  const hasError = typeof body.error === "string" && body.error.trim();
  let status = String(body.status ?? "").toLowerCase();
  if (!status && hasError) status = "failed";
  if (FAILED_WORDS.has(status)) {
    return {
      status: "failed",
      progress: 0,
      error: hasError || "merge job failed",
      expiresAt: body.expiresAt,
    };
  }
  if (DONE_WORDS.has(status)) {
    // فضّل videoUrl ثم downloadUrl ثم رابط الفيديو المباشر من jobId
    const videoUrl =
      (typeof body.videoUrl === "string" && body.videoUrl) ||
      (typeof body.downloadUrl === "string" && body.downloadUrl) ||
      `${mergerBase()}/api/jobs/${jobId}/video`;
    return {
      status: "done",
      progress: 100,
      videoUrl,
      downloadUrl:
        typeof body.downloadUrl === "string" && body.downloadUrl
          ? body.downloadUrl
          : `${mergerBase()}/api/jobs/${jobId}/video?download=1`,
      expiresAt: body.expiresAt,
    };
  }
  // queued/processing/أي شيء آخر → جارية
  let progress = Number(body.progress ?? 0);
  if (!Number.isFinite(progress)) progress = 0;
  if (progress <= 1) progress = Math.round(progress * 100); // كسر 0..1
  progress = Math.max(0, Math.min(99, Math.round(progress)));
  return {
    status: status === "queued" ? "queued" : "processing",
    progress,
    videoUrl: typeof body.videoUrl === "string" ? body.videoUrl : undefined,
    expiresAt: body.expiresAt,
  };
}

export const mergerClient = {
  /** إنشاء مهمة دمج من روابط مباشرة */
  async createJob(urls: string[]): Promise<{
    jobId: string;
    statusUrl?: string;
    processUrl?: string;
    expiresAt?: string;
  }> {
    const { ok, status, body } = await mergerFetch(
      "/api/jobs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videos: urls }),
      },
      30_000,
    );
    if (!ok) {
      // أي خطأ HTTP معلن من الخدمة عند الإنشاء = فشل حتمي (يُصنَّف params لأن مصادرنا صالحة والخدمة رفضت)
      throw new ProviderError(
        status,
        `merger create failed: ${body?.error ?? `HTTP ${status}`}`,
      );
    }
    const jobId = body?.jobId;
    if (!jobId) throw new ProviderError(200, "merger create: missing jobId");
    return {
      jobId: String(jobId),
      statusUrl: body?.statusUrl,
      processUrl: body?.processUrl,
      expiresAt: body?.expiresAt,
    };
  },

  /** تنفيذ الدمج — متزامن ~10-15 ثانية. تُطلق مرة واحدة فقط (قفل خارجي). */
  async processJob(jobId: string): Promise<void> {
    const { ok, status, body } = await mergerFetch(
      `/api/jobs/${encodeURIComponent(jobId)}/process`,
      { method: "POST" },
    );
    if (!ok) {
      if (status === 202) return; // قيد المعالجة بالفعل — لا بأس
      // 500 + {"error": "..."} مثل مصدر يرفض التحميل = فشل حتمي نهائي
      throw new ProviderError(status, `merge process failed: ${body?.error ?? `HTTP ${status}`}`);
    }
  },

  /** حالة المهمة */
  async getJob(jobId: string): Promise<MergerJobStatus> {
    const { ok, status, body } = await mergerFetch(
      `/api/jobs/${encodeURIComponent(jobId)}`,
      { method: "GET" },
      20_000,
    );
    if (status === 404) {
      // مهمة غير موجودة — حُذفت أو انتهت صلاحيتها بعد 24 ساعة
      throw new ProviderError(404, "merge job not found (deleted or expired after 24h)");
    }
    if (!ok && !body?.error) {
      throw new ProviderError(null, `merger status HTTP ${status}`); // خطأ غير معلن — مؤقت
    }
    return parseMergerStatus(body, jobId);
  },

  /** حذف فوري (تنظيف اختياري) */
  async deleteJob(jobId: string): Promise<void> {
    try {
      await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" }, 15_000);
    } catch {
      // التنظيف اختياري — لا نوقف أي شيء بسبب فشل الحذف
    }
  },

  /** حدود الخدمة الحالية — تُستخدم لفحص الجهوزية في /api/health */
  async getConfig(timeoutMs = 4000): Promise<{ healthy: boolean; config?: unknown }> {
    if (!mergerBase()) return { healthy: false };
    try {
      const res = await fetch(`${mergerBase()}/api/config`, {
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
      return { healthy: res.ok, config: res.ok ? await res.json().catch(() => undefined) : undefined };
    } catch {
      return { healthy: false };
    }
  },
};
