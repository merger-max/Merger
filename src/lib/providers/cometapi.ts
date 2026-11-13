/**
 * مزود CometAPI (المزود الثاني) — وفق البرومبت:
 *  - صور متزامنة عبر نقطة images المتوافقة مع OpenAI (تعيد الرابط/b64_json فورًا).
 *  - فيديو عبر نقطة مهام غير متزامنة بنفس نمط create/check.
 * التوثيق العام لـ api.cometapi.com متغير؛ الالتزم بالأنماط الواردة في البرومبت،
 * وأي انحراف يُصنَّف تلقائيًا عبر classifyProviderError ويتابع المفاتيح التالية بأمان.
 */
import { ProviderError } from "../keys";
import type { ProviderAdapter, GenerateTaskInput } from "./types";

const BASE = (process.env.COMETAPI_BASE_URL ?? "https://api.cometapi.com").replace(/\/$/, "");
const TIMEOUT_MS = 60_000;

async function cometFetch(path: string, key: string, init?: RequestInit): Promise<any> {
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
      body?.error?.message ||
      body?.message ||
      body?.msg ||
      JSON.stringify(body).slice(0, 300);
    throw new ProviderError(res.status, String(msg));
  }
  return body;
}

function buildCometImageInput(input: GenerateTaskInput): Record<string, unknown> {
  const p = input.params ?? {};
  const out: Record<string, unknown> = {
    model: input.providerModel,
    prompt: input.prompt,
  };
  if (p.aspect_ratio && p.aspect_ratio !== "auto") {
    // صور OpenAI-style تستخدم size — نحوّل النسبة إلى مقاس تقريبي عند الإمكان
    const map: Record<string, string> = {
      "1:1": "1024x1024",
      "16:9": "1792x1024",
      "9:16": "1024x1792",
      "3:2": "1536x1024",
      "2:3": "1024x1536",
    };
    if (map[p.aspect_ratio as string]) out.size = map[p.aspect_ratio as string];
  }
  if (p.output_format && p.output_format !== "png") out.output_format = p.output_format;
  if (p.background && p.background !== "auto") out.background = p.background;
  return out;
}

export const cometApiAdapter: ProviderAdapter = {
  /** صور متزامنة — النتيجة فورًا (رابط أو b64_json) */
  async createImageSync(key, input) {
    const body = await cometFetch("/v1/images/generations", key, {
      method: "POST",
      body: JSON.stringify(buildCometImageInput(input)),
    });
    const items = body?.data ?? [];
    const urls: string[] = [];
    for (const item of Array.isArray(items) ? items : []) {
      if (item?.url) urls.push(String(item.url));
      else if (item?.b64_json) urls.push(`data:image/png;base64,${item.b64_json}`);
    }
    if (!urls.length) {
      throw new ProviderError(res_status(body), "no image URL in response");
    }
    return { urls };
  },

  async createTask(key, _model, input) {
    // فيديو — نمط مهام غير متزامن (create/check)
    const p = input.params ?? {};
    const payload: Record<string, unknown> = {
      model: input.providerModel,
      input: {
        prompt: input.prompt,
        ...(typeof p.image_url === "string" && p.image_url.trim()
          ? { image_url: p.image_url.trim() }
          : {}),
        ...(p.aspect_ratio && p.aspect_ratio !== "auto" ? { aspect_ratio: p.aspect_ratio } : {}),
        ...(p.resolution ? { resolution: p.resolution } : {}),
        ...(p.duration ? { duration: p.duration } : {}),
        ...(p.enable_audio !== undefined ? { enable_audio: p.enable_audio } : {}),
      },
    };
    const body = await cometFetch("/v1/video/createTask", key, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const taskId = body?.data?.taskId ?? body?.taskId ?? body?.data?.task_id ?? body?.id;
    if (!taskId) {
      throw new ProviderError(200, "missing taskId in createTask response");
    }
    return { providerTaskId: String(taskId) };
  },

  async checkTask(key, providerTaskId) {
    const body = await cometFetch(
      `/v1/video/queryTask?taskId=${encodeURIComponent(providerTaskId)}`,
      key,
    );
    const data = body?.data ?? body ?? {};
    const state = String(data?.state ?? data?.status ?? "").toLowerCase();

    if (["success", "completed", "complete", "succeeded"].includes(state)) {
      let urls: string[] = [];
      const raw = data?.resultUrls ?? data?.video_url ?? data?.videoUrl ?? data?.url;
      if (Array.isArray(raw)) urls = raw.map((u: unknown) => String(u));
      else if (typeof raw === "string") urls = [raw];
      else if (typeof data?.resultJson === "string") {
        try {
          const parsed = JSON.parse(data.resultJson);
          if (Array.isArray(parsed?.resultUrls)) urls = parsed.resultUrls.map(String);
        } catch { /* تجاهل */ }
      }
      if (!urls.length) return { status: "failed", error: "success state without result URLs" };
      return { status: "completed", urls, progress: 100 };
    }
    if (["fail", "failed", "error"].includes(state)) {
      return { status: "failed", error: String(data?.failMsg ?? data?.error ?? "provider task failed") };
    }
    const progress =
      typeof data?.progress === "number"
        ? data.progress <= 1
          ? Math.round(data.progress * 100)
          : Math.round(data.progress)
        : undefined;
    return { status: "processing", progress };
  },
};

function res_status(body: any): number {
  return typeof body?.code === "number" ? body.code : 200;
}
