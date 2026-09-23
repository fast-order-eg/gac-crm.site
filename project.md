# توثيق مشروع gac-crm.site

هذا الملف يحتوي على الدليل الشامل لبيئة العمل، البنية التحتية، إعدادات السيرفر، وطريقة النشر بنظام **الزيرو داون تايم (Zero-Downtime)**. يُرجى الاعتماد عليه عند بدء أي جلسة عمل جديدة.

---

## 1. نظرة عامة على المشروع (Project Overview)

- **الرابط المباشر:** [https://gac-crm.site](https://gac-crm.site)
- **مسار فحص الحالة (Health Check):** [https://gac-crm.site/health](https://gac-crm.site/health)
- **طبيعة النظام:** نظام CRM متكامل لإدارة العملاء والمحادثات والمبيعات مع روبوتات محادثة ذكية (WhatsApp عبر مكتبة Baileys، و Facebook Messenger / Instagram) مدعومة بـ Gemini AI و Socket.IO للتحديثات اللحظية.
- **التقنيات المستخدمة:**
  - **Node.js:** الإصدار 20 (ES Modules `type: module`)
  - **Express 5:** الويب وسيرفر الـ API
  - **Socket.IO:** التحديثات الحية والشات المباشر
  - **Sequelize ORM:** التعامل مع قواعد البيانات (MySQL في الإنتاج، SQLite محلياً)
  - **EJS:** محرك القوالب والصفحات
  - **PM2:** مدير العمليات على السيرفر
  - **OpenLiteSpeed:** السيرفر العاكس (Reverse Proxy) عبر CyberPanel

---

## 2. مستودع GitHub والربط المباشر

- **رابط المستودع (GitHub Repository):**  
  `https://github.com/fast-order-eg/gac-crm.site.git`
- **المنظمة (Organization):** `fast-order-eg`
- **الفرع الأساسي:** `main`
- **توكن الوصول المعتمد (PAT):**  
  التوكن المعتمد لمنظمة `fast-order-eg` (المبدوء بـ `ghp_pgHMK...` ومحفوظ تلقائياً داخل إعدادات الـ git remote وسكربت deploy.sh بالسيرفر).
- **صيغة رابط الـ Remote:**  
  `https://<GITHUB_TOKEN>@github.com/fast-order-eg/gac-crm.site.git`

---

## 3. بيئة السيرفر والاستضافة (Server Infrastructure)

- **الاسم المعرف في ملف SSH (`~/.ssh/config`):** `my-cyberpanel`
- **عنوان الـ IP:** `72.60.188.135`
- **المستخدم:** `root`
- **المسار على السيرفر (App Directory):**  
  `/home/gac-crm.site/public_html`
- **اسم العملية في PM2:**  
  `gac-crm` (الـ ID الحالي: `4`)
- **المنفذ الداخلي (Internal Port):** `4500`
- **التوجيه (Reverse Proxy):**  
  يقوم OpenLiteSpeed بتوجيه أي زائر يدخل على `gac-crm.site` داخلياً إلى `127.0.0.1:4500` مع دعم الـ WebSockets.

---

## 4. نظام الزيرو داون تايم وآلية الرفع التلقائي (Zero-Downtime Deployment)

تم تجهيز المشروع بنفس آلية مشروع `bot.bird-ads.com`:

### أ) سكريبت الرفع على السيرفر:
موجود في المسار: `/home/gac-crm.site/deploy.sh`  
ويقوم بالآتي:
1. جلب أحدث كود من GitHub عبر `git fetch` و `git reset --hard FETCH_HEAD`.
2. تثبيت الحزم الجديدة عبر `npm install --production`.
3. عمل ريلود بدون توقف عبر `pm2 reload gac-crm`.
4. السيرفر مزود بـ **Graceful Shutdown** يستقبل إشارة `SIGINT` ويغلق اتصالات الـ HTTP وقاعدة البيانات بأمان تام خلال إطلاق النسخة الجديدة.

### ب) طريقة الرفع من جهازك المحلي بضغطة واحدة:
تم إنشاء سكربت `deploy.ps1` في المجلد الرئيسي للمشروع:
```powershell
.\deploy.ps1 "رسالة الـ commit هنا"
```
يقوم هذا السكربت تلقائياً بعمل:
1. `git add .` و `git commit`
2. `git push origin main`
3. تنفيذ `ssh my-cyberpanel "/home/gac-crm.site/deploy.sh"` فورياً.

ويمكنك أيضاً تنفيذ أمر الرفع يدوياً عبر SSH في أي وقت:
```bash
ssh my-cyberpanel "/home/gac-crm.site/deploy.sh"
```

---

## 5. قاعدة البيانات (Database Architecture)

- **اسم القاعدة:** `gacc_crm`
- **المستخدم:** `gacc_crm`
- **ملاحظة تقنية هامة جداً (Case Sensitivity):**  
  نظام Linux يتعامل بحساسية تامة مع حروف أسماء الجداول (Case-Sensitive). جميع الجداول الـ 19 في قاعدة البيانات مكتوبة بحروف صغيرة (Lowercase).  
  **قاعدة أساسية:** عند إضافة أو تعديل أي موديل في مجلد `models/`، يجب دائماً تعيين خيار `tableName` صراحةً بالحروف الصغيرة، مثال:
  ```javascript
  const MyModel = sequelize.define('MyModel', { ... }, {
      tableName: 'my_models'
  });
  ```

---

## 6. أوامر المتابعة والصيانة السريعة عبر SSH

- **فحص حالة التطبيق:**
  ```bash
  ssh my-cyberpanel "pm2 status gac-crm"
  ```
- **عرض السجلات الحية (Live Logs):**
  ```bash
  ssh my-cyberpanel "pm2 logs gac-crm --lines 50"
  ```
- **فحص استجابة السيرفر المحلي:**
  ```bash
  ssh my-cyberpanel "curl -s http://127.0.0.1:4500/health"
  ```
- **فحص استجابة الدومين:**
  ```bash
  curl -I https://gac-crm.site
  ```
