/**
 * مزود QwenCloud — منصة Alibaba العالمية الجديدة (qwencloud.com، أُطلقت عالميًا 26 مايو 2026).
 * المصدر: docs.qwencloud.com (api-reference/image-generation/qwen-text-to-image + video-generation/text-to-video
 * + api-reference/preparation/api-key). الواجهة بأسلوب DashScope والمفتاح يُنشأ من home.qwencloud.com/api-keys.
 *
 * صور متزامنة (Real-time — استجابة 200 تحمل الرابط فورًا):
 *   POST {BASE}/api/v1/services/aigc/multimodal-generation/generation
 *        Authorization: Bearer {key}
 *        body: { "model": "qwen-image-2.1-turbo",
 *                "input": { "messages": [{ "role": "user", "content": [{ "text": "..." }] }] },
 *                "parameters": { "size": "1024*1024", "n": 1, "watermark": false } }
 *        → { "output": { "choices": [{ "message": { "content": [{ "image": "https://…png" }] } }] } }
 *        الرابط PNG ينتهي بعد 24 ساعة ("URL … Valid for 24 hours") — يُسلَّم فورًا للعميل بلا تنزيل وسيط.
 *
 * فيديو غير متزامن (X-DashScope-Async):
 *   POST {BASE}/api/v1/services/aigc/video-generation/video-synthesis
 *        body: { "model": "wan2.7-t2v", "input": { "prompt": "…" },
 *                "parameters": { "resolution": "720P", "ratio": "16:9", "duration": 8 } }
 *        → { "output": { "task_id": "…" } }
 *   GET  {BASE}/api/v1/tasks/{task_id}
 *        → { "output": { "task_status": "PENDING|RUNNING|SUCCEEDED|FAILED", "video_url": "…" } }
 *   ملاحظات: wan3.0/wan2.7 يستخدمان (resolution + ratio) بينما wan2.6 وأقدم يستخدمون (size)؛
 *   المدد: wan2.7 في [2,15]، wan2.6 ∈ {5,10,15}، wan2.5 ∈ {5,10}، wan2.1 = 5.
 *
 * نقطة الاتصال مرتبطة بنوع المفتاح (docs: "each key is bound to its own base URL"):
 *   - sk-sp-… → token-plan.maas.qwencloudapi.com (خطة الاشتراك — سنغافورة فقط)
 *   - سواها   → {region}.maas.qwencloudapi.com — المنطقة من صيغة "region:key" أو QWENCLOUD_REGION
 *   (افتراضي ap-southeast-1 — سنغافورة، الأقرب زمنيًا لمنطقتنا).
 */
import { ProviderError } from "../keys";
import type { ProviderAdapter, GenerateTaskInput } from "./types";

const TIMEOUT_MS = 60_000;
const DEFAULT_REGION = process.env.QWENCLOUD_REGION ?? "ap-southeast-1";
const TOKEN_PLAN_HOST = "https://token-plan.maas.qwencloudapi.com";
const REGION_RE = /^[a-z]{2,3}-[a-z]+-[0-9]+$/; // مثل ap-southeast-1

/** نقطة الاتصال حسب صيغة المفتاح — "region:key" أو sk-sp- أو الافتراضي من البيئة */
function baseUrl(key: string): string {
  const k = key.trim();
  if (k.startsWith("sk-sp-")) return TOKEN_PLAN_HOST;
  const idx = k.indexOf(":");
  if (idx > 0 && REGION_RE.test(k.slice(0, idx))) {
    return `https://${k.slice(0, idx)}.maas.qwencloudapi.com`;
  }
  return `https://${DEFAULT_REGION}.maas.qwencloudapi.com`;
}

/** التوكن الفعلي بعد فصل بادئة المنطقة إن وُجدت */
function tokenOf(key: string): string {
  const k = key.trim();
  const idx = k.indexOf(":");
  if (idx > 0 && REGION_RE.test(k.slice(0, idx))) return k.slice(idx + 1).trim();
  return k;
}

async function qcFetch(url: string, key: string, init?: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${tokenOf(key)}`,
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
    const msg = body?.message || body?.code || `HTTP ${res.status}`;
    throw new ProviderError(res.status, `${msg} (request_id: ${body?.request_id ?? "?"})`);
  }
  return body;
}

/** نسبة الأبعاد → حجم بالبكسل ضمن حدود التوثيق (512*512..2048*2048، مضاعفات 32) */
const RATIO_SIZES: Record<string, string> = {
  "1:1": "1024*1024",
  "16:9": "1280*720",
  "9:16": "720*1280",
  "3:2": "1536*1024",
  "2:3": "1024*1536",
  "4:3": "1152*864",
  "3:4": "864*1152",
  "5:4": "1280*1024",
  "4:5": "1024*1280",
  "2:1": "1536*768",
  "1:2": "768*1536",
  "21:9": "1536*640",
  "9:21": "640*1536",
  "3:1": "1920*640",
  "1:3": "640*1920",
};

/** المدد المسموحة لكل جيل Wan — تقريب قيمة العميل لأقرب قيمة مقبولة */
function snapDuration(model: string, d: number): number {
  if (/wan2\.1/.test(model)) return 5;
  if (/wan2\.5/.test(model)) return d <= 5 ? 5 : 10;
  if (/wan2\.6/.test(model)) return d <= 5 ? 5 : d <= 10 ? 10 : 15;
  return Math.min(15, Math.max(2, Math.round(d))); // wan2.7 / wan3.0: [2,15]
}

export const qwencloudAdapter: ProviderAdapter = {
  async createImageSync(key: string, { prompt, params, providerModel }: GenerateTaskInput) {
    const parameters: Record<string, unknown> = { n: 1, watermark: false };
    const ratio = typeof params.aspect_ratio === "string" ? params.aspect_ratio : "auto";
    if (ratio !== "auto" && RATIO_SIZES[ratio]) parameters.size = RATIO_SIZES[ratio];
    const data = await qcFetch(
      `${baseUrl(key)}/api/v1/services/aigc/multimodal-generation/generation`,
      key,
      {
        method: "POST",
        body: JSON.stringify({
          model: providerModel,
          input: { messages: [{ role: "user", content: [{ text: prompt }] }] },
          parameters,
        }),
      },
    );
    const content = data?.output?.choices?.[0]?.message?.content;
    const urls: string[] = (Array.isArray(content) ? content : [])
      .map((c: any) => (typeof c?.image === "string" ? c.image : null))
      .filter(Boolean);
    if (!urls.length) {
      throw new ProviderError(null, `no image in QwenCloud response (request_id: ${data?.request_id ?? "?"})`);
    }
    return { urls };
  },

  async createTask(key: string, model: string, { prompt, params }: GenerateTaskInput) {
    const m = model.toLowerCase();
    const useResRatio = m.startsWith("wan3.0") || m.startsWith("wan2.7"); // الجيل الجديد: resolution+ratio
    const parameters: Record<string, unknown> = {};
    if (useResRatio) {
      parameters.resolution = String(params.resolution ?? "720p").toUpperCase(); // 720p → 720P
      const ratio = typeof params.aspect_ratio === "string" ? params.aspect_ratio : "auto";
      if (ratio !== "auto") parameters.ratio = ratio;
    } else {
      const ratio = typeof params.aspect_ratio === "string" ? params.aspect_ratio : "auto";
      if (ratio !== "auto" && RATIO_SIZES[ratio]) parameters.size = RATIO_SIZES[ratio];
    }
    const d = Number(params.duration);
    if (Number.isFinite(d) && d > 0) parameters.duration = snapDuration(m, d);
    const input: Record<string, unknown> = { prompt };
    if (typeof params.image_url === "string" && params.image_url) input.image_url = params.image_url;
    const data = await qcFetch(
      `${baseUrl(key)}/api/v1/services/aigc/video-generation/video-synthesis`,
      key,
      {
        method: "POST",
        headers: { "X-DashScope-Async": "enable" },
        body: JSON.stringify({ model, input, parameters }),
      },
    );
    const taskId = data?.output?.task_id;
    if (!taskId) {
      throw new ProviderError(null, `no task_id in QwenCloud response (request_id: ${data?.request_id ?? "?"})`);
    }
    return { providerTaskId: String(taskId) };
  },

  async checkTask(key: string, providerTaskId: string) {
    const data = await qcFetch(
      `${baseUrl(key)}/api/v1/tasks/${encodeURIComponent(providerTaskId)}`,
      key,
    );
    const out = data?.output ?? {};
    const st = String(out.task_status ?? "").toUpperCase();
    if (st === "SUCCEEDED") {
      const v = out.video_url ?? out.result_url ?? (Array.isArray(out.videos) ? out.videos[0]?.url : undefined);
      const urls = typeof v === "string" && v ? [v] : [];
      if (!urls.length) return { status: "failed" as const, error: "task SUCCEEDED without video_url" };
      return { status: "completed" as const, urls };
    }
    if (st === "FAILED" || st === "CANCELED" || st === "UNKNOWN") {
      return { status: "failed" as const, error: out.message || out.code || `task ${st}` };
    }
    return { status: "processing" as const };
  },
};
