# ⚡ MCP Media Generator + Video Merger Service

نظامان مترابطان في مستودع واحد:

1. **تطبيق MCP Media Generator** (جذر المستودع — Next.js 16 + TypeScript + Tailwind)
   خادم MCP على المسار `/mcp` لتوليد الصور والفيديو بالذكاء الاصطناعي عبر **5 مزودين** (kie.ai + CometAPI + Cloudflare Workers AI + Volcengine Seedance + Novita) ودمج المقاطع، مع **تبديل مفاتيح تسلسلي تلقائي** ولوحة إدارة عربية RTL.

2. **خدمة دمج الفيديو** (مجلد `merger-service/` — Node.js خالص لدوال Vercel Serverless)
   موقع دمج فيديوهات + واجهة API عامة، تنفّذ الدمج بـ ffmpeg داخل الدالة وتخزّن كل شيء في Turso — هي نفسها `MERGER_API_BASE` التي يستخدمها التطبيق الأول لدمج المقاطع.

**قاعدة جوهرية:** لا يُنزَّل أي ملف وسائط على سيرفر التوليد إطلاقًا — روابط النتائج فقط تُخزَّن في قاعدة البيانات.

---

## 🚀 النشر على Vercel خطوة بخطوة

### الخطوة 0 — قاعدة Turso (تمت بالفعل لمشروع merger-medo)

```bash
# لإنشاء قاعدة جديدة مستقبلًا:
turso db create <name>
turso db show <name> --url          # يعطي TURSO_DATABASE_URL
turso db tokens create <name>       # يعطي TURSO_AUTH_TOKEN
```

المشروعان يستطيعان مشاركة نفس القاعدة (الجداول مختلفة ولا تتصادم).

### الخطوة 1 — نشر خدمة الدمج أولًا (لأننا نحتاج رابطها)

1. Vercel → **Add New → Project** → اختر مستودع `Merger`.
2. في **Root Directory** اختر: `merger-service`
3. Framework Preset: **Other** (يكتشف تلقائيًا ملفات `api/`)
4. أضف متغيرات البيئة (Settings → Environment Variables):

| المتغير | القيمة |
|---|---|
| `TURSO_DATABASE_URL` | `libsql://merger-medo.aws-eu-west-1.turso.io` |
| `TURSO_AUTH_TOKEN` | توكن Turso بصلاحيات كتابة |

5. **Deploy** — سيصلك رابط مثل `https://<اسم-المشروع>.vercel.app`
6. اختبر: `curl https://<رابط-الخدمة>/api/config` → يجب أن يعيد JSON الحدود.

### الخطوة 2 — نشر تطبيق MCP

1. Vercel → **Add New → Project** → نفس المستودع (مرة ثانية).
2. **Root Directory:** اتركه فارغًا (جذر المستودع) — يكتشف Next.js تلقائيًا.
3. أضف متغيرات البيئة:

| المتغير | القيمة |
|---|---|
| `TURSO_DATABASE_URL` | نفس القيمة أعلاه |
| `TURSO_AUTH_TOKEN` | نفس القيمة أعلاه |
| `MERGER_API_BASE` | رابط خدمة الدمج من الخطوة 1 |
| `MCP_ACCESS_TOKEN` *(اختياري)* | إن ضُبط يُطلب `Authorization: Bearer <token>` على `/mcp` |

4. **Deploy**.

### الخطوة 3 — الربط بأي عميل MCP

انسخ رابط التطبيق المطلق + `/mcp`، ثم من **لوحة الإدارة** (بطاقة «ربط السيرفر») انسخ JSON الجاهز لكل عميل:

- **ChatGPT:** Settings → Connectors → Create → Custom MCP server → ضع الرابط في «Server URL».
- **Claude Desktop:** انسخ JSON التبويب الثاني إلى `claude_desktop_config.json`.
- **Cursor / Windsurf / Cline:** انسخ JSON التبويب الثالث إلى `mcp.json`.

---

## 🖥️ التشغيل المحلي

```bash
# التطبيق الرئيسي (Next.js)
cp .env.example .env.local    # ثم ضع القيم الحقيقية
npm install
npm run dev                   # http://localhost:3000

# خدمة الدمج
cd merger-service
cp .env.example .env          # ثم ضع قيم Turso
npm install
npm run dev                   # http://localhost:3001

# اختبارات خدمة الدمج (الخادم يعمل أولًا)
npm run test:unit             # 11 اختبار: محرك الدمج + التخزين + الحدود
npm run test:http             # 20 اختبار: كل نقاط API
```

---

## 🔑 نظام المفاتيح المتسلسلة (قلب التوليد)

- أضف عدة مفاتيح من أي مزود من الخمسة: **kie.ai / CometAPI / Cloudflare / Volcengine / Novita** — من لوحة الإدارة.
- **التجربة تسلسلية صارمة بترتيب الإضافة** (`created_at ASC, id ASC`) — ليست round-robin.
- عند أي خطأ: تعطيل تلقائي (401/403)، أو تعليم `exhausted` (402/نفاد رصيد)، أو الانتقال للمفتاح التالي — **دون توقف المهمة**، ونفس `task_id` يُستأنف على المفتاح التالي.
- المفتاح المستنزف يبقى في القاعدة ويُجرَّب أولًا دائمًا — لو شحنت رصيده تكتمل المهمة المعلقة تلقائيًا مع أول `get_task`.
- نموذج الذكاء الاصطناعي **لا يرى أبدًا** أخطاء المفاتيح أو الرصيد — التبديل صامت تمامًا.
- إخفاء المفاتيح إلزامي في كل الاستجابات (`ABCD123••••••••WXYZ`).
- الموديل لا يُرسل لمزود لا يقدر عليه — المزودون الجدد يخدمون موديلاتهم فقط (سجل الموديلات يحدد من يخدم ماذا).

## 🎁 المزودون الخمسة وموديلاتهم

| المزود | الموديل | النوع | الحصة المجانية | ملاحظات المفتاح |
|---|---|---|---|---|
| kie.ai | `gpt-image-2-6/flare-text-to-image` و `grok-imagine-video-1-5-preview` | صور + فيديو | 80 كريديت للحساب الجديد | من لوحة الحساب |
| CometAPI | نفس الاثنين أعلاه (أسماء بالنقاط) | صور + فيديو | كريديت تجريبي بدون بطاقة | من cometapi.com |
| **Cloudflare Workers AI** | `flux-1-schnell` | صور متزامنة | **10,000 نيورون/يوم للأبد** (~40 صورة يوميًا) | من dash.cloudflare.com — الصق بصيغة `account_id:token` أو التوكن فقط (يُحلَّل الحساب تلقائيًا) |
| **Volcengine (Ark)** | `seedance-1-0-pro` | فيديو 3–12 ثانية | حصة ترحيبية ~8 فيديوهات 1080p | مفتاح Ark من console.volcengine.com |
| **Novita AI** | `flux-1-schnell` | صور غير متزامنة | حتى $100 ساندبوكس / 90 يوم | من novita.ai — روابط صورها لها صلاحية محدودة (TTL) |

أسماء الموديلات لكل مزود قابلة للتجاوز بمتغيرات البيئة: `CF_IMAGE_MODEL`, `VOLC_VIDEO_MODEL`, `NOVITA_IMAGE_MODEL` (+ القديمة `KIE_*` و `COMETAPI_*`).

## 🧰 الأدوات الخمس على /mcp

| الأداة | الوظيفة |
|---|---|
| `generate_image` | توليد صورة — موديل `gpt-image-2-6/flare-text-to-image` (kie/CometAPI) أو `flux-1-schnell` (Cloudflare/Novita المجانية) — تعيد الرابط جاهزًا إن اكتملت خلال نافذة الانتظار وإلا `task_id`. |
| `generate_video` | توليد فيديو — موديل `grok-imagine-video-1-5-preview` (صوت أصلي متزامن 1–15ث، image-to-video اختياري) أو `seedance-1-0-pro` (Volcengine، 3–12ث). |
| `merge_videos` | دمج 2–10 مقاطع بالترتيب عبر `urls` مباشرة أو `task_ids` لمهام مكتملة — الناتج يُحذف بعد ~24 ساعة. |
| `get_task` | تتبع أي مهمة (توليد/دمج) ويحدّثها حية من المزود/الخدمة. |
| `list_media` | أحدث الوسائط المخزنة بروابطها بدون إعادة توليد. |

الردود كلها بالعربية، وإشعارات التقدم تُبث حيًا كل ~3 ثوانٍ عندما يوفر العميل `progressToken`.

---

## 📡 API خدمة الدمج (بدون تسجيل، CORS مفتوح، أخطاء `{"error":"..."}`)

| Method | Endpoint | الوظيفة |
|---|---|---|
| `POST` | `/api/jobs` | إنشاء مهمة دمج — `{"videos":[...]}` أو `{"sources":[{"kind":"url"|"file",...}]}` → `201` مع `jobId` و`uploads[]` للملفات |
| `POST` | `/api/upload?job=&seq=&chunk=` | رفع أجزاء الملفات (ثنائي ≤4MB مع إعادة محاولة في الواجهة) |
| `POST` | `/api/jobs/{id}/process` | تنفيذ الدمج كاملًا (متزامن) → `{"status":"done","videoUrl",...}` أو `202` إن كانت تعمل فعلًا |
| `GET` | `/api/jobs/{id}` | الحالة + التقدم (0–100) + الرابط عند الاكتمال |
| `GET` | `/api/jobs/{id}/video` | بث الناتج بدعم **Range (206)** و `?download=1` للتحميل |
| `DELETE` | `/api/jobs/{id}` | حذف فوري شامل |
| `GET` | `/api/config` | الحدود العامة + version |
| `GET` | `/api/cron` | حذف المهام المنتهية (Cron يومي في vercel.json) |

مثال:

```bash
curl -X POST https://<merger-service>.vercel.app/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"videos":["https://example.com/a.mp4","https://example.com/b.mp4"]}'

curl -X POST https://<merger-service>.vercel.app/api/jobs/<jobId>/process
curl https://<merger-service>.vercel.app/api/jobs/<jobId>/video -o out.mp4
```

### محرك الدمج

- ffprobe لكل مصدر → توحيد عبر `filter_complex`: scale+pad إلى أكبر دقة بين المدخلات (حد 1920×1080 أبعاد زوجية)، fps=30، setsar=1، yuv420p ثم `concat` (ترتيب مدخلات متداخل لكل مقطع حسب ffmpeg 7).
- مصدر بلا صوت → مسار صامت `anullsrc` بنفس مدته بدل فشل الدمج.
- الترميز: **libx264 CRF 18 + AAC 192k/44100Hz + +faststart** → MP4 فوري التشغيل على الويب.
- التقدم يُقرأ من `-progress pipe:1` (0–40 سحب المصادر، 40–90 ترميز، 100 اكتمال) ويُخزَّن في القاعدة.
- استحواذ ذري (`process_started_at`) يسمح باستئناف عملية مقطوعة ويمنع التزامن.
- لا نظام ملفات دائم — `/tmp` فقط والتنظيف في `finally`.

### الحدود (قابلة للضبط بمتغيرات البيئة)

| الحد | القيمة الافتراضية | المتغير |
|---|---|---|
| أقصى عدد مقاطع | 10 | `MAX_SOURCES` |
| حجم كل مصدر | 200MB | `SOURCE_MAX_MB` |
| حجم الناتج | 150MB | `OUTPUT_MAX_MB` |
| مجموع المدد | 600 ثانية | `MAX_TOTAL_DURATION_SEC` |
| جزء الرفع | 4MB | `UPLOAD_CHUNK_BYTES` |
| صف التخزين في Turso | 2MB | `STORAGE_CHUNK_BYTES` |
| مدة الدالة على Vercel | 300 ثانية | `vercel.json → maxDuration` |
| حذف تلقائي | 24 ساعة | `EXPIRE_HOURS` |

**التخزين:** كل Blob يُقسَّم صفوفًا بحجم 2MB (حد HTTP في Turso) ويُقرأ تدفقيًا بصفحات من 8 صفوف — بلا S3 ولا خدمات خارجية.

---

## ⚠️ ملاحظات مهمة

- **kie.ai:** الأسماء الحقيقية للموديلات تستخدم الشرطات (`gpt-image-2-6/flare-text-to-image`, `grok-imagine-video-1-5-preview`) — تم قياسها من `GET /api/v1/models` الفعلي.
- موديل الفيديو grok-imagine-video-1.5: الصوت أصلي ولا يمكن إيقافه — حقل `enable_audio` يُقبل من الأداة ولا يُرسل لـ kie.
- موديل `grok-imagine-video-1-5-preview` يحتاج رصيدًا كافيًا — عند 402 يُعلَّم المفتاح `exhausted` وتبقى المهمة «بانتظار توفر مفتاح صالح…» وتكتمل تلقائيًا بعد الشحن.
- **CometAPI:** النقاط المطبعة متوافقة مع الأنماط المعلنة (`/v1/images/generations` متزامن للصور + مهام غير متزامنة للفيديو) — لم يُختبر بمفتاح حقيقي بعد، وأي انحراف يُصنَّف تلقائيًا ويتابع المفاتيح التالية.
- **Cloudflare:** صور flux-1-schnell متزامنة تُعاد كـ data URI (base64) — لا مهمة غير متزامنة ولا تنزيل وسائط. مفتاح بصيغة خاطئة أو بلا صلاحية قراءة الحسابات → خطأ فئة `provider` فتتابع المفاتيح التالية بلا توقف.
- **Volcengine:** مدة Seedance 1.0 Pro تُقيَّد على 3–12 ثانية والنسب غير المدعومة تُحوَّل لأقرب نسبة (auto → adaptive). مهمة فاشلة لدى Ark ترجع حقل `error` مع HTTP 200 — يعالجها محقق المهام كفشل مهام لا كخطأ شبكة.
- **Novita:** صور فقط عبر `v3/async/txt2img` (غلاف `request` + استعلام `v3/async/task-result` بحالات `TASK_STATUS_*`) — نقاط نهاية الفيديو لديها متغيرة حاليًا فتُغطى الفيديوهات المجانية من Volcengine، وروابط الصور الناتجة لها TTL قصير.
- اختبار المزودين الجدد (بدون شبكة، fetch وهمي): `npx tsx scripts/test-new-providers.mts` — 40 تأكيدًا.
- على Vercel: `maxDuration = 300` على مسار `/mcp` وخدمة الدمج — تأكد أن خطتك تسمح بها، وإن لم تسمح خفّض `wait_seconds` في استدعاءات الأدوات.
- `.env*` مستثنى من Git منذ أول commit — لا أسرار في المستودع إطلاقًا، ولا تُطبع مفاتيح كاملة في أي استجابة.

## 📁 البنية

```
├── src/lib/            # turso | keys | models | providers (kie, cometapi, cloudflare, volc, novita) | orchestrator | merger | mcpServer
├── src/app/mcp/route.ts        # خادم MCP (Streamable HTTP — stateless)
├── src/app/api/                # health | keys | keys/[id] | tasks
├── src/app/page.tsx            # لوحة الإدارة العربية RTL
├── scripts/                    # test-new-providers.mts (اختبار المزودين الثلاثة الجدد)
└── merger-service/
    ├── api/            # jobs.js | jobs/[id].js | jobs/[id]/process.js | jobs/[id]/video.js | upload.js | config.js | cron.js
    ├── lib/            # db.js (تخزين Turso مجزّأ) | merge.js (ffmpeg) | http.js
    ├── public/         # واجهة الدمج العربية RTL (ثيم داكن سماوي/بنفسجي)
    └── scripts/        # dev-server.js | test-unit.js | test-http.js
```
