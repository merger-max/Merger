/**
 * اختبار حقيقي لمزود Cloudflare عبر الكود الفعلي في المشروع (نفس مسار الإنتاج).
 * المفتاح يُقرأ من متغير البيئة CF_TEST_KEY بصيغة "account_id:token" — لا يُخزَّن في أي ملف.
 * الناتج: صورة تجريبية تُحفظ في download/ مع تقرير مفصّل في الطرفية.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { cloudflareAdapter } from "../src/lib/providers/cloudflare";

async function main() {
  const key = process.env.CF_TEST_KEY;
  if (!key || !key.includes(":")) {
    console.error("✗ متغير البيئة CF_TEST_KEY مفقود أو بصيغة خاطئة (المطلوب: account_id:token)");
    process.exit(1);
  }
  const prompt =
    process.env.CF_TEST_PROMPT ??
    "A futuristic Middle Eastern city at golden sunset, modern architecture, warm cinematic lighting, highly detailed";

  console.log("→ استدعاء cloudflareAdapter.createImageSync من كود المشروع الفعلي…");
  const t0 = Date.now();
  const res = await cloudflareAdapter.createImageSync(key, {
    prompt,
    providerModel: "@cf/black-forest-labs/flux-1-schnell",
    params: {},
  } as never);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  const dataUri: string = res.urls[0];
  if (!dataUri?.startsWith("data:image/")) {
    console.error("✗ الناتج ليس data URI للصورة:", dataUri?.slice(0, 60));
    process.exit(1);
  }
  const b64 = dataUri.slice(dataUri.indexOf(",") + 1);
  const buf = Buffer.from(b64, "base64");

  // كشف الصيغة الفعلية من البايتات الأولى (لا نثق في الامتداد المعلن)
  const isPng = buf[0] === 0x89 && buf[1] === 0x50;
  const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
  const ext = isPng ? "png" : isJpg ? "jpg" : "bin";
  if (ext === "bin") {
    console.error("✗ البايتات الأولى ليست PNG ولا JPEG — قد يكون الناتج تالفًا");
    process.exit(1);
  }

  const dir = "/home/z/my-project/download";
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/cloudflare-test-image.${ext}`;
  writeFileSync(path, buf);

  console.log(`✓ نجح التوليد خلال ${secs}s | عدد الروابط: ${res.urls.length}`);
  console.log(`✓ الحجم: ${(buf.length / 1024).toFixed(0)}KB | الصيغة الفعلية: ${ext.toUpperCase()}`);
  console.log(`✓ الصورة محفوظة في: ${path}`);
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error("✗ فشل التوليد:", msg);
  process.exit(1);
});
