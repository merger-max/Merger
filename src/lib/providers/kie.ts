/**
 * مزود kie.ai — Jobs API الموحد (الشكل الحقيقي المقاس من docs.kie.ai):
 *   POST https://api.kie.ai/api/v1/jobs/createTask   → {"code":200,"data":{"taskId":"..."}}
 *   GET  https://api.kie.ai/api/v1/jobs/recordInfo?taskId=...
 *        → {"code":200,"data":{"state":"waiting|queuing|generating|success|fail",
 *            "resultJson":"{\"resultUrls\":[\"https://...\"]}",  // نص JSON داخل JSON
 *            "failMsg":"..."}}
 * ملاحظات:
 *  - موديل الفيديو grok-imagine-video-1.5-preview: الصوت أصلي ولا يمكن إيقافه، لذا نتجاهل enable_audio.
 *    الحقل الأول للصورة المرجعية هو image_urls (مصفوفة).
 *  - موديل الصورة يدعم prompt/aspect_ratio/resolution/quality/background/output_format.
 */
import { ProviderError } from "../keys";
import type { ProviderAdapter, GenerateTaskInput } from "./types";

const BASE = "https://api.kie.ai";
const TIMEOUT_MS = 30_000;

async function kieFetch(path: string, key: string, init?: RequestInit): Promise<any> {
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
    // انقطاع شبكة/مهلة → temporary (status null)
    throw new ProviderError(null, `network error: ${err?.message ?? String(err)}`);
  }

  let body: any = null;
  try {
    body = await res.json();
  } catch {
    throw new ProviderError(res.status, `invalid JSON response (HTTP ${res.status})`);
  }

  // kie.ai يرجع code داخل الجسم أيضًا — نفضّل الأخطاء المعلنة
  const innerCode = typeof body?.code === "number" ? body.code : undefined;
  const okStatus = res.status >= 200 && res.status < 300;
  const okInner = innerCode === undefined ? true : innerCode === 200;
  if (!okStatus || !okInner) {
    const msg =
      body?.msg ||
      body?.message ||
      body?.error?.message ||
      JSON.stringify(body).slice(0, 300);
    throw new ProviderError(res.status, String(msg));
  }
  return body;
}

function buildKieInput(type: "image" | "video", input: GenerateTaskInput): Record<string, unknown> {
  const p = input.params ?? {};
  const out: Record<string, unknown> = { prompt: input.prompt };
  const keep = (field: string, v: unknown, skipIfAuto = false) => {
    if (v === undefined || v === null || v === "") return;
    if (skipIfAuto && String(v) === "auto") return; // auto = نترك الحقل للمزود
    out[field] = v;
  };

  if (type === "image") {
    // الشكل المقاس من docs.kie.ai لموديل gpt-image flare
    keep("aspect_ratio", p.aspect_ratio, true);
    keep("resolution", p.resolution);
    keep("background", p.background, true);
    keep("output_format", p.output_format);
  } else {
    // grok-imagine-video-1.5-preview — الصوت دائم الأصلي (لا enable_audio)
    keep("aspect_ratio", p.aspect_ratio, true);
    keep("resolution", p.resolution);
    keep("duration", p.duration);
    const imageUrl = typeof p.image_url === "string" ? p.image_url.trim() : "";
    if (imageUrl) out.image_urls = [imageUrl];
  }
  return out;
}

export const kieAdapter: ProviderAdapter = {
  async createTask(key, _model, input) {
    const type = input.params.__type === "video" ? "video" : "image";
    const body = {
      model: input.providerModel,
      input: buildKieInput(type, input),
    };
    const data = await kieFetch("/api/v1/jobs/createTask", key, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const taskId = data?.data?.taskId;
    if (!taskId) {
      throw new ProviderError(200, "missing taskId in createTask response");
    }
    return { providerTaskId: String(taskId) };
  },

  async checkTask(key, providerTaskId) {
    const data = await kieFetch(
      `/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`,
      key,
    );
    const rec = data?.data ?? {};
    const state = String(rec.state ?? "").toLowerCase();

    if (state === "success" || state === "completed") {
      // resultJson نص JSON داخل JSON — يحتاج JSON.parse ثانيًا
      let urls: string[] = [];
      try {
        const parsed =
          typeof rec.resultJson === "string"
            ? JSON.parse(rec.resultJson)
            : rec.resultJson;
        const raw = parsed?.resultUrls ?? parsed?.results ?? parsed?.url;
        if (Array.isArray(raw)) urls = raw.map((u: unknown) => String(u));
        else if (typeof raw === "string") urls = [raw];
      } catch {
        // لا شيء — نحاول حقولًا بديلة
        if (typeof rec.resultUrl === "string") urls = [rec.resultUrl];
      }
      if (!urls.length) {
        return { status: "failed", error: "success state without result URLs" };
      }
      return { status: "completed", urls, progress: 100 };
    }

    if (state === "fail" || state === "failed" || state === "error") {
      const msg = String(rec.failMsg ?? rec.failCode ?? "provider task failed");
      return { status: "failed", error: msg };
    }

    // waiting | queuing | generating | ...
    const progress =
      typeof rec.progress === "number"
        ? rec.progress <= 1
          ? Math.round(rec.progress * 100)
          : Math.round(rec.progress)
        : undefined;
    return { status: "processing", progress };
  },
};
