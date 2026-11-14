/**
 * مزود Novita AI — الصور عبر واجهة المهام غير المتزامنة v3 (الشكل المقاس من التوثيق الرسمي):
 *   POST https://api.novita.ai/v3/async/txt2img    Authorization: Bearer {API Key}
 *        body: { "extra": { "response_image_type": "jpeg" },
 *                "request": { "prompt": "...", "model_name": "flux-1-schnell", "width": 1024, "height": 1024, "image_num": 1 } }
 *        → { "task_id": "..." }
 *   GET  https://api.novita.ai/v3/async/task-result?task_id=...
 *        → { "task": { "status": "TASK_STATUS_QUEUED|TASK_STATUS_PROCESSING|TASK_STATUS_SUCCEED|TASK_STATUS_FAILED",
 *                      "reason": "...", "progress_percent": 0-100 },
 *            "images": [ { "image_url": "https://..." } ], "videos": [ { "video_url": "..." } ] }
 * ملاحظة: روابط صور Novita لها صلاحية محدودة (image_url_ttl) — تُعرض وتُنزَّل مباشرة.
 * الفيديو غير مفعل هنا — تغطيته عبر مزود Volcengine (نقاط نهاية فيديو Novita متغيرة حاليًا).
 */
import { ProviderError } from "../keys";
import type { ProviderAdapter, GenerateTaskInput } from "./types";

const BASE = (process.env.NOVITA_BASE_URL ?? "https://api.novita.ai").replace(/\/$/, "");
const TIMEOUT_MS = 60_000;

/** نسبة العرض→(width,height) بمضاعفات 64 — تُتجاهل للنسب غير المخططة */
const SIZE_MAP: Record<string, [number, number]> = {
  "1:1": [1024, 1024],
  "16:9": [1024, 576],
  "9:16": [576, 1024],
  "4:3": [1024, 768],
  "3:4": [768, 1024],
  "3:2": [1152, 768],
  "2:3": [768, 1152],
  "21:9": [1344, 576],
};

async function novitaFetch(path: string, key: string, init?: RequestInit): Promise<any> {
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
  if (!res.ok || body?.error) {
    const msg =
      body?.message ||
      body?.error?.message ||
      body?.msg ||
      JSON.stringify(body).slice(0, 300);
    throw new ProviderError(res.status, String(msg));
  }
  return body;
}

export const novitaAdapter: ProviderAdapter = {
  async createTask(key, _model, input) {
    const p = input.params ?? {};
    if (p.__type !== "image") {
      // رسالة فئة provider — إن ظهر موديل فيديو جديد على Novita مستقبلًا يُضاف هنا
      throw new ProviderError(404, "model not found: novita serves image generation only");
    }

    const request: Record<string, unknown> = {
      prompt: input.prompt,
      model_name: input.providerModel,
      image_num: 1,
    };
    const size = SIZE_MAP[String(p.aspect_ratio ?? "")];
    if (size) {
      request.width = size[0];
      request.height = size[1];
    }
    const body = {
      extra: { response_image_type: "jpeg" },
      request,
    };

    const data = await novitaFetch("/v3/async/txt2img", key, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const taskId = data?.task_id ?? data?.data?.task_id;
    if (!taskId) {
      throw new ProviderError(200, "missing task_id in novita txt2img response");
    }
    return { providerTaskId: String(taskId) };
  },

  async checkTask(key, providerTaskId) {
    const data = await novitaFetch(
      `/v3/async/task-result?task_id=${encodeURIComponent(providerTaskId)}`,
      key,
    );
    const task = data?.task ?? {};
    const status = String(task.status ?? "");

    if (status === "TASK_STATUS_SUCCEED") {
      const imgs = Array.isArray(data?.images) ? data.images : [];
      const vids = Array.isArray(data?.videos) ? data.videos : [];
      const urls = [
        ...imgs.map((x: any) => String(x?.image_url ?? "")).filter(Boolean),
        ...vids.map((x: any) => String(x?.video_url ?? "")).filter(Boolean),
      ];
      if (!urls.length) {
        return { status: "failed", error: "succeed state without image/video URLs" };
      }
      return { status: "completed", urls, progress: 100 };
    }

    if (status === "TASK_STATUS_FAILED") {
      return { status: "failed", error: String(task.reason ?? "novita task failed") };
    }

    // QUEUED | PROCESSING | غير معروف
    const progress =
      typeof task.progress_percent === "number"
        ? Math.min(100, Math.max(0, Math.round(task.progress_percent)))
        : undefined;
    return { status: "processing", progress };
  },
};
