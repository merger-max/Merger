/**
 * مزود Agnes AI — صور وفيديو بواجهة متوافقة مع OpenAI (حصة مجانية للبدء، حد ~20 صورة/دقيقة).
 * المصادر: agnes-ai.com + wiki.agnes-ai.com (Agnes Video 2.5 — Quickstart):
 *   POST {BASE}/v1/images/generations   Authorization: Bearer {key}
 *        body: { "model": "agnes-image-2.1-flash", "prompt": "...", "n": 1 }
 *        → { "data": [ { "b64_json"?: "...", "url"?: "https://..." } ] }   (شكل OpenAI)
 *   POST {BASE}/v1/videos
 *        body: { "model": "agnes-video-2.5", "prompt": "..." }
 *        → { "video_id": "..." }
 *   GET  {BASE}/agnesapi?video_id={id}&model_name={model}
 *        → حالة المهمة + رابط الفيديو (أسماء الحقول قد تختلف بين الإصدارات — تحليل مرن)
 *
 * ملاحظة تصميم: نقطة الاستعلام تشترط model_name بجانب video_id، بينما واجهة
 * checkTask الموحدة تمرر (key, providerTaskId) فقط — لذا نضغط اسم الموديل داخل
 * providerTaskId بصيغة "model@@video_id" (معرّف داخلي لا يظهر للعميل إطلاقًا
 * ولا يُخزَّن إلا في tasks.provider_task_id) — يعمل بأمان في بيئة serverless.
 */
import { ProviderError } from "../keys";
import type { ProviderAdapter, GenerateTaskInput } from "./types";

const BASE = (process.env.AGNES_BASE_URL ?? "https://apihub.agnes-ai.com").replace(/\/$/, "");
const TIMEOUT_MS = 60_000;
const SEP = "@@";
const DEFAULT_VIDEO_MODEL = "agnes-video-2.5";

async function agnesFetch(url: string, key: string, init?: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err: any) {
    throw new ProviderError(null, `network error: ${err?.message ?? String(err)}`);
  }
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    throw new ProviderError(res.status, `invalid JSON response (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const msg =
      body?.message ||
      body?.error?.message ||
      body?.msg ||
      JSON.stringify(body).slice(0, 300);
    throw new ProviderError(res.status, String(msg));
  }
  return body;
}

const DONE_SET = new Set(["completed", "succeed", "succeeded", "success", "done", "finished"]);
const FAIL_SET = new Set(["failed", "error", "rejected", "canceled", "cancelled"]);

export const agnesAdapter: ProviderAdapter = {
  /** صور متزامنة — شكل OpenAI: إما b64_json (نغلفه data URI) أو url (نمرره كما هو) */
  async createImageSync(key: string, input: GenerateTaskInput) {
    const data = await agnesFetch(`${BASE}/v1/images/generations`, key, {
      method: "POST",
      body: JSON.stringify({ model: input.providerModel, prompt: input.prompt, n: 1 }),
    });
    const item = Array.isArray(data?.data) ? data.data[0] : undefined;
    const b64 = typeof item?.b64_json === "string" && item.b64_json.length ? item.b64_json : undefined;
    const url = typeof item?.url === "string" && item.url.length ? item.url : undefined;
    if (b64) return { urls: [`data:image/png;base64,${b64}`] };
    if (url) return { urls: [url] };
    throw new ProviderError(200, "missing image payload in agnes images response");
  },

  /** فيديو فقط — الصور تخدمها createImageSync أعلاه */
  async createTask(key: string, _model: string, input: GenerateTaskInput) {
    const data = await agnesFetch(`${BASE}/v1/videos`, key, {
      method: "POST",
      body: JSON.stringify({ model: input.providerModel, prompt: input.prompt }),
    });
    const videoId = data?.video_id ?? data?.id ?? data?.data?.video_id ?? data?.data?.id;
    if (!videoId) {
      throw new ProviderError(200, "missing video id in agnes createTask response");
    }
    return { providerTaskId: `${input.providerModel}${SEP}${videoId}` };
  },

  async checkTask(key: string, providerTaskId: string) {
    // نفكّ "model@@video_id" — ومعرفات بلا فاصل نرجع لاسم الموديل الافتراضي
    const idx = providerTaskId.indexOf(SEP);
    const modelName = idx > 0 ? providerTaskId.slice(0, idx) : DEFAULT_VIDEO_MODEL;
    const videoId = idx > 0 ? providerTaskId.slice(idx + SEP.length) : providerTaskId;
    const data = await agnesFetch(
      `${BASE}/agnesapi?video_id=${encodeURIComponent(videoId)}&model_name=${encodeURIComponent(modelName)}`,
      key,
    );
    const status = String(data?.status ?? data?.task_status ?? data?.state ?? "").toLowerCase();

    if (DONE_SET.has(status)) {
      const candidates = [
        data?.video_url,
        data?.url,
        data?.download_url,
        data?.result_url,
        data?.video?.url,
        data?.video?.download_url,
        data?.result?.url,
      ];
      const found = candidates.find((u: unknown) => typeof u === "string" && (u as string).length > 0);
      if (!found) {
        return { status: "failed" as const, error: "completed state without video url in agnes response" };
      }
      return { status: "completed" as const, urls: [String(found)], progress: 100 };
    }
    if (FAIL_SET.has(status)) {
      const msg = String(data?.message ?? data?.error?.message ?? data?.reason ?? `agnes task ${status}`);
      return { status: "failed" as const, error: msg };
    }
    const pct = Number(data?.progress ?? data?.percent);
    return {
      status: "processing" as const,
      ...(Number.isFinite(pct) ? { progress: Math.max(0, Math.min(100, Math.round(pct))) } : {}),
    };
  },
};
