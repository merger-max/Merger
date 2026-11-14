/**
 * مزود Volcengine Ark — موديلات ByteDance Seedance للفيديو (حصة ترحيبية مجانية كبيرة).
 * الشكل المقاس من التوثيق الرسمي (docs.volcengine.com — Seedance video generation):
 *   POST {BASE}/contents/generations/tasks    Authorization: Bearer {ARK_API_KEY}
 *        body: { "model": "doubao-seedance-1-0-pro-250528",
 *                "content": [ { "type": "text", "text": "..." },
 *                             { "type": "image_url", "image_url": { "url": "..." }, "role": "first_frame" } ],
 *                "resolution": "480p|720p|1080p", "ratio": "16:9", "duration": 5, "watermark": false }
 *        → { "id": "cgt-..." }
 *   GET  {BASE}/contents/generations/tasks/{id}
 *        → { "status": "queued|running|succeeded|failed|expired",
 *            "content": { "video_url": "https://..." }, "error": {...} }
 * ملاحظة مدة: Seedance 1.0 Pro يقبل 3–12 ثانية — نقيّد المدة على هذا المدى (قابلة للتجاوز بموديل آخر عبر VOLC_VIDEO_MODEL).
 */
import { ProviderError } from "../keys";
import type { ProviderAdapter, GenerateTaskInput } from "./types";

const BASE = (process.env.VOLC_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/v3").replace(/\/$/, "");
const TIMEOUT_MS = 60_000;
const DURATION_MIN = 3;
const DURATION_MAX = 12; // مدى Seedance 1.0 Pro
const DURATION_DEFAULT = 5;

const RATIOS = new Set(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);
const RATIO_FALLBACK: Record<string, string> = {
  "3:2": "4:3",
  "2:3": "3:4",
  "2:1": "21:9",
  "1:2": "9:16",
};

async function arkFetch(
  path: string,
  key: string,
  init?: RequestInit,
  opts?: { allowErrorBody?: boolean },
): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
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
  // ملاحظة: استعلام المهمة يُرجع حقل error مع HTTP 200 للمهام الفاشلة —
  // فيُسمح بجسم الخطأ هنا ويتولى checkTask تفسيره، أما إنشاء المهمة فيرفعه كخطأ.
  if (opts?.allowErrorBody && res.ok && body?.error) return body;
  if (!res.ok || body?.error) {
    // أخطاء Ark بصيغة OpenAI: { "error": { "code": "...", "message": "..." } }
    const msg =
      body?.error?.message ||
      body?.message ||
      body?.msg ||
      JSON.stringify(body).slice(0, 300);
    throw new ProviderError(res.status, String(msg));
  }
  return body;
}

function buildRatio(aspect: unknown): string {
  const v = typeof aspect === "string" ? aspect.trim() : "";
  if (!v || v === "auto") return "adaptive";
  if (RATIOS.has(v)) return v;
  return RATIO_FALLBACK[v] ?? "adaptive";
}

function buildDuration(d: unknown): number {
  const n = typeof d === "number" ? Math.round(d) : Number(d);
  if (!Number.isFinite(n)) return DURATION_DEFAULT;
  return Math.min(DURATION_MAX, Math.max(DURATION_MIN, n));
}

export const volcAdapter: ProviderAdapter = {
  async createTask(key, _model, input) {
    const p = input.params ?? {};
    const content: Array<Record<string, unknown>> = [
      { type: "text", text: input.prompt },
    ];
    const imageUrl = typeof p.image_url === "string" ? p.image_url.trim() : "";
    if (imageUrl) {
      content.push({ type: "image_url", image_url: { url: imageUrl }, role: "first_frame" });
    }
    const body: Record<string, unknown> = {
      model: input.providerModel,
      content,
      resolution: typeof p.resolution === "string" ? p.resolution : "720p",
      ratio: buildRatio(p.aspect_ratio),
      duration: buildDuration(p.duration),
      watermark: false,
    };
    const data = await arkFetch("/contents/generations/tasks", key, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const taskId = data?.id ?? data?.data?.id;
    if (!taskId) {
      throw new ProviderError(200, "missing task id in Seedance createTask response");
    }
    return { providerTaskId: String(taskId) };
  },

  async checkTask(key, providerTaskId) {
    const data = await arkFetch(
      `/contents/generations/tasks/${encodeURIComponent(providerTaskId)}`,
      key,
      undefined,
      { allowErrorBody: true },
    );
    const status = String(data?.status ?? "").toLowerCase();

    if (status === "succeeded") {
      const videoUrl = data?.content?.video_url;
      const urls: string[] = Array.isArray(videoUrl)
        ? videoUrl.map((u: unknown) => String(u))
        : videoUrl
          ? [String(videoUrl)]
          : [];
      if (!urls.length) {
        return { status: "failed", error: "succeeded state without video_url" };
      }
      return { status: "completed", urls, progress: 100 };
    }

    if (status === "failed" || status === "expired" || status === "cancelled") {
      const msg = String(data?.error?.message ?? data?.error?.code ?? `seedance task ${status}`);
      return { status: "failed", error: msg };
    }

    // queued | running | ... — لا حقل تقدم معلن لدى Ark
    return { status: "processing" };
  },
};
