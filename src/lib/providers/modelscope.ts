/**
 * مزود ModelScope API-Inference — صور مجانية يومية من Alibaba (2,000 نداء/يوم، تتجدد كل صباح).
 * الشكل المقاس من التوثيق الرسمي (modelscope.ai — API-Inference):
 *   POST {BASE}/images/generations
 *        Authorization: Bearer {ModelScope SDK Token — يبدأ بـ ms-}
 *        X-ModelScope-Async-Mode: true
 *        body: { "model": "Tongyi-MAI/Z-Image-Turbo", "prompt": "..." }
 *        → { "task_id": "...", "task_status": "PENDING" }
 *   GET  {BASE}/tasks/{task_id}
 *        → { "task_status": "PENDING | RUNNING | SUCCEED | FAILED",
 *            "output_images": ["https://..."], "message"?: "..." }
 * القيود المعلنة: 2,000 نداء يوميًا لكل مستخدم + 200 نداء لكل موديل —
 * التجاوز يرجع 429 فيُصنَّف temporary فيبقى المفتاح سليمًا وينتقل التالي.
 */
import { ProviderError } from "../keys";
import type { ProviderAdapter, GenerateTaskInput } from "./types";

const BASE = (process.env.MODELSCOPE_BASE_URL ?? "https://api-inference.modelscope.cn/v1").replace(/\/$/, "");
const TIMEOUT_MS = 60_000;

async function msFetch(path: string, key: string, init?: RequestInit): Promise<any> {
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
  if (!res.ok) {
    const msg =
      body?.message ||
      body?.msg ||
      body?.error?.message ||
      (Array.isArray(body?.errors) ? body.errors.join("; ") : body?.errors) ||
      JSON.stringify(body).slice(0, 300);
    throw new ProviderError(res.status, String(msg));
  }
  return body;
}

export const modelscopeAdapter: ProviderAdapter = {
  async createTask(key: string, _model: string, input: GenerateTaskInput) {
    const data = await msFetch("/images/generations", key, {
      method: "POST",
      headers: { "X-ModelScope-Async-Mode": "true" },
      body: JSON.stringify({ model: input.providerModel, prompt: input.prompt }),
    });
    const taskId = data?.task_id ?? data?.data?.task_id;
    if (!taskId) {
      throw new ProviderError(200, "missing task id in ModelScope createTask response");
    }
    return { providerTaskId: String(taskId) };
  },

  async checkTask(key: string, providerTaskId: string) {
    const data = await msFetch(`/tasks/${encodeURIComponent(providerTaskId)}`, key);
    const status = String(data?.task_status ?? "").toUpperCase();

    if (status === "SUCCEED") {
      const imgs: string[] = Array.isArray(data?.output_images)
        ? data.output_images.map((u: unknown) => String(u)).filter(Boolean)
        : [];
      if (!imgs.length) {
        return { status: "failed" as const, error: "SUCCEED state without output_images" };
      }
      return { status: "completed" as const, urls: imgs, progress: 100 };
    }
    if (status === "FAILED") {
      const raw = data?.message ?? data?.errors ?? data?.msg;
      const msg = String(Array.isArray(raw) ? raw.join("; ") : (raw ?? `modelscope task FAILED`));
      return { status: "failed" as const, error: msg };
    }
    // PENDING | RUNNING | غير معروف — لا حقل تقدم معلن لدى API-Inference
    return { status: "processing" as const };
  },
};
