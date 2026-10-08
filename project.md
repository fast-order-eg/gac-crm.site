# 🚀 توثيق ودليل مشروع gac-crm.site الشامل (PROJECT.md)

> **تنبيه هام للذكاء الاصطناعي (AI Assistant):**  
> هذا الملف هو المرجع الأساسي والشامل لكل تفاصيل النظام، البنية التحتية، محرك الواتساب، لوحة التحكم، وقواعد العمل.  
> **اقرأ هذا الملف في بداية أي جلسة عمل جديدة لتفهم كامل المشروع فوراً وتوفر استهلاك التوكنز.**

---

## 📌 1. القواعد الصارمة للتعامل (Strict Rules for AI)
1. **لغة التحدث:** الرد دائماً على المستخدم بالعامية المصرية البسيطة والمباشرة.
2. **ملف الملخص:** ممنوع نهائياً إنشاء ملف `walkthrough.md` (غير مطلوب)، اكتب الملخص في رسالة الرد فقط.
3. **ملف المهام:** عند إنشاء أو تعديل `tasks.md`، اجعل العناوين والمهام كلها باللغة العربية.
4. **تحديثات التقدم (Progress Updates):** خليها دائماً باللغة العربية.
5. **طريقة النشر والتعديل:** التعديلات تتم **محلياً فقط** داخل هذا المجلد، وبعد الانتهاء يتم اختبارها ورفعها للسيرفر فوراً عبر سكربت الزيرو داون تايم `.\deploy.ps1`. **ممنوع التعديل مباشرة على السيرفر عبر SSH**.
6. **أوامر التيرمنال:** لا تستخدم أمر `cd` للتنقل بين المجلدات في أوامر التيرمنال إطلاقاً.

---

## 🏢 2. نظرة عامة على المشروع (Project Overview)
- **اسم المشروع:** GAC CRM & WhatsApp Automation System.
- **الدومين الرئيسي:** [https://gac-crm.site](https://gac-crm.site)
- **فحص الحالة (Health Check):** [https://gac-crm.site/health](https://gac-crm.site/health)
- **الهدف:** نظام CRM متكامل لإدارة عملاء أكاديمية GAC (كورسات لغات: إنجليزي وألماني)، يتضمن:
  - بوت واتساب ذكي ومتقدم مبني على مكتبة `@whiskeysockets/baileys`.
  - دمج مع الذكاء الاصطناعي Google Vertex AI (Gemini 2.5) لتوليد الردود، والملخصات، ورسائل المتابعة المتغيرة لمنع الحظر.
  - نظام محادثات حية فورية (LiveChat) لموظفي المبيعات وخدمة العملاء مع دعم الفويس نوت والوسائط.
  - ميزات واتساب المتقدمة: الردود المقتبسة (Quotes/Replies)، وتفاعلات الإيموجي (Reactions)، وتتبع الرسائل بروابط وعارض صور (Lightbox).
  - نظام التحويل البشري الذكي (Auto-Handoff) وتوزيع العملاء على موظفي المبيعات وحساب الـ KPI ومعدل سرعة الاستجابة.
  - إشعارات فورية عبر Socket.IO وإشعارات المتصفح (Web Push Notifications - VAPID).

---

## 🛠️ 3. البنية التقنية (Tech Stack)
- **البيئة الأساسية:** Node.js v20 (بنظام ES Modules `type: module`).
- **إطار العمل (Backend):** Express 5.
- **قاعدة البيانات:** MySQL 8 عبر Sequelize ORM.
  - **الترميز الإجباري:** `utf8mb4` و `utf8mb4_unicode_ci` لدعم إيموجي الواتساب بالكامل.
- **محرك الواتساب:** `@whiskeysockets/baileys` (جلسات متعددة Multi-Session محفوظة في مجلد `sessions/`).
- **محرك الذكاء الاصطناعي:** Google Vertex AI (`@google-cloud/vertexai` و `google-auth-library`) عبر Service Account `fast-order-505012-2adde4c0badf.json`.
- **التحديثات اللحظية:** `socket.io` للدردشة المباشرة وتحديثات التفاعلات وحالة الاتصال.
- **الواجهة الأمامية (Frontend):** قوالب EJS، و Bootstrap 5، و Bootstrap Icons، و JavaScript فانيلا سريع ومحسن.

---

## 🖥️ 4. بيانات السيرفر والاستضافة (Server Infrastructure)
- **مزود الاستضافة:** CyberPanel + OpenLiteSpeed.
- **عنوان السيرفر (IP):** `72.60.188.135`
- **مستخدم السيرفر:** `root`
- **اختصار الـ SSH في النظام المحلي:** `my-cyberpanel` (أو `root@72.60.188.135`).
- **مسار التطبيق على السيرفر:**  
  `/home/gac-crm.site/public_html`
- **المنفذ الداخلي للتطبيق (Port):** `4500`
- **إدارة العمليات:** PM2 تحت اسم التطبيق: `gac-crm` (Process ID: `3`).
- **قاعدة البيانات (MySQL):**
  - **Host:** `localhost` / `127.0.0.1`
  - **Database:** `gacc_crm`
  - **User:** `gacc_crm`
  - **Password:** `GacCrm_DB_Pass2026`
  - **أمر الاتصال المباشر عبر السيرفر:**  
    `mysql --default-character-set=utf8mb4 -u gacc_crm -pGacCrm_DB_Pass2026 -D gacc_crm`

---

## ⚡ 5. نظام الزيرو داون تايم وآلية النشر (Zero-Downtime Deployment)

المشروع مصمم ليعمل 24/7 دون أي انقطاع لجلسات الواتساب أو فقدان لأي رسائل واردة:

### أ) سكريبت النشر المحلي (`deploy.ps1`):
موجود في المجلد الرئيسي للمشروع، ويتم استدعاؤه من PowerShell:
```powershell
.\deploy.ps1 "وصف مختصر للتعديلات التي تمت"
```

### ب) خطوات عمل السكريبت التلقائية:
1. **إضافة التعديلات لـ Git:** `git add .` وعمل `git commit -m "<رسالة>"`.
2. **الرفع إلى GitHub:** `git push origin main` على مستودع `https://github.com/fast-order-eg/gac-crm.site.git`.
3. **تشغيل سكربت السيرفر عبر SSH:** يستدعي أمر:  
   `ssh my-cyberpanel "/home/gac-crm.site/deploy.sh"`
4. **تنفيذ النشر السلس في السيرفر (`deploy.sh`):**
   - يجلب أحدث كود عبر `git fetch` و `git reset --hard FETCH_HEAD`.
   - يثبت الحزم الجديدة (إن وجدت) عبر `npm install --production`.
   - يقوم بعمل **Graceful Reload** عبر `pm2 reload gac-crm`.
   - السيرفر مزود بـ Graceful Shutdown (`SIGINT`) حيث ينهي الطلبات الجارية بأمان ويعيد تشغيل الجلسات في الخلفية فوراً دون أن يشعر المستخدم أو العميل بأي انقطاع (Zero Downtime).

---

## 📂 6. هيكلية الملفات الأساسية (Core Architecture)

```
gac-crm.site/
├── server.js                      # نقطة الدخول الرئيسية، إعدادات Express، Socket.IO، RateLimit، و Trust Proxy
├── deploy.ps1                     # سكريبت النشر التلقائي من الجهاز المحلي للسيرفر
├── config/
│   ├── database.js                # إعداد اتصال Sequelize بـ MySQL مع دعم utf8mb4 الإجباري
│   └── uploadConfig.js            # إعدادات رفع الملفات والمستندات
├── controllers/
│   ├── botController.js           # القلب النابض للنظام (محرك Baileys، إرسال واستقبال الرسائل، Vertex AI، Reactions)
│   ├── messengerController.js     # محرك ربط فيسبوك وإنستغرام ماسنجر
│   └── ...
├── routes/
│   ├── dashboard.js               # مسارات لوحة التحكم والشات المباشر (/dashboard/livechat/*)
│   ├── admin.js                   # مسارات الإدارة والمستخدمين
│   └── ...
├── services/
│   ├── whatsappQueueService.js    # طابور إرسال الواتساب المنظم لمنع الحظر
│   ├── kpiService.js              # تسجيل وحساب سرعة استجابة الموظفين وأدائهم
│   ├── assignmentService.js       # توزيع العملاء تلقائياً على موظفي المبيعات
│   └── webPushService.js          # إرسال إشعارات المتصفح (Web Push)
├── views/
│   ├── livechat.ejs               # واجهة الدردشة اللحظية الشاملة (مشغل فويس، ريبلاي، تفاعلات، عارض صور)
│   └── partials/                  # القوائم وشريط التنقل والناوتفكيشنز
└── public/
    └── uploads/
        └── media/                 # وسائط اللايف شات المحفوظة (صور، فويسات، فيديوهات، مستندات)
```

---

## ⚠️ 7. أخطاء شائعة وتحذيرات تقنية حرجة (Crucial Gotchas)

1. **فخ مسار `public_html` ومسارات الوسائط:**
   - مسار السيرفر على لينكس هو: `/home/gac-crm.site/public_html/...`.
   - **تحذير:** إياك أن تستخدم `filePath.indexOf('public')` لاستخراج الرابط؛ لأنه سيطابق كلمة `public` في `public_html` ويولد مساراً خاطئاً مثل `/_html/public/uploads/...`، مما يسبب خطأ 404 وتحميل المتصفح لملفات `.htm` تالفة.
   - **القاعدة:** استخرج المسار دائماً بالبحث عن مجلد `/uploads/` ليصبح الرابط دائماً `/uploads/media/...`.

2. **ترميز الرموز التعبيرية (Emoji & utf8mb4):**
   - الرموز التعبيرية في واتساب (مثل 👍، ❤️) تتطلب 4 بايت في UTF-8.
   - يجب أن يظل خيار `charset: 'utf8mb4'` و `collate: 'utf8mb4_unicode_ci'` مفعلاً دائماً في `config/database.js`، وأي استعلامات يدوية يجب أن تتضمن `--default-character-set=utf8mb4`.

3. **الـ Reverse Proxy وحظر الـ IP (Rate Limiting):**
   - التطبيق يعمل خلف OpenLiteSpeed، لذا يجب الحفاظ على `app.set('trust proxy', 1)` في `server.js`.
   - مسارات `/dashboard` و `/livechat` والملفات الاستاتيكية معفاة ومستثناة من قيود الـ Rate Limiter لضمان عدم حظر موظفي الشركة أثناء العمل المكثف.

4. **معرفات الـ LID مقابل أرقام الهواتف في واتساب:**
   - بعض العملاء يرسلون معرفات من نوع LID (مثل `87845133914231@lid`).
   - يحتفظ النظام بـ `lidPhoneMap` ويفحص رقم هاتف العميل من جدول `customers`، ولديه دائماً آلية **Fallback** تلقائية للإرسال إلى رقم الهاتف (`@s.whatsapp.net`) إذا فشل الإرسال المباشر للـ LID.

5. **تفاعلات الإيموجي (Reactions):**
   - دالة `sendReaction` مصممة لتكون مقاومة للأخطاء: لو الرسالة قديمة ولا تملك `messageId` لواتساب، تقوم بحفظ التفاعل في قاعدة البيانات فوراً وإظهاره في اللايف شات مع إرجاع تحذير دون رمي خطأ 500.
   - لو الرسالة تملك `messageId`، يتم إرسال التفاعل لواتساب وتحديث هاتف العميل ومزامنة قاعدة البيانات والسوكيت.
   - يستمع البوت لحدثين في Baileys: حدث `messages.reaction` وحدث `reactionMessage` في `messages.upsert` لدعم استقبال التفاعلات الصادرة من الموبايل فورياً.

6. **تنظيف ردود الذكاء الاصطناعي (AI Clean Output):**
   - دالة `extractCleanAiText` تضمن تنظيف أي كود JSON مسرب مثل `{"reply": "..."}`، وتحذف محارف الـ ZWJ والتمديد غير المرئي (مثل `بتمتحنـ`) لمنع تشويه الكلمات العربية.

---

## 🛠️ 8. أوامر صيانة وسريعة عبر SSH

```bash
# فحص حالة البوت في PM2
ssh my-cyberpanel "pm2 status gac-crm"

# متابعة السجلات اللحظية
ssh my-cyberpanel "pm2 logs gac-crm --lines 40"

# فحص كفاءة السيرفر محلياً
ssh my-cyberpanel "curl -I http://127.0.0.1:4500/health"

# تنفيذ أمر النشر اليدوي المباشر
ssh my-cyberpanel "/home/gac-crm.site/deploy.sh"
```
