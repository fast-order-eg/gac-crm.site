# قائمة المهام: نظام الإشعارات الفورية (Web Push) وإشعارات رسائل العملاء للموظفين

## المراحل السابقة (تم الإنجاز)
- [x] نظام طابور الواتساب الموحد ومحاكاة الكتابة البشرية والحماية القصوى ضد الحظر <!-- id: 10 -->

## المرحلة الحالية: نقل نظام الإشعارات والويب بوش من crm.fast-order-eg.tech (جاري التنفيذ)
- [ ] 1. تثبيت مكتبة web-push وإنشاء موديل PushSubscription.js وتحديث Notification.js (إضافة new_message و customer_note) <!-- id: 30 -->
- [ ] 2. إنشاء خدمة webPushService.js ومفاتيح VAPID الدائمة (config/vapid.json) والـ Service Worker (public/sw.js) <!-- id: 31 -->
- [ ] 3. تحديث notificationService.js لإرسال إشعارات Web Push في الخلفية للموظفين على الموبايل والكمبيوتر <!-- id: 32 -->
- [ ] 4. تحديث صفحة الإشعارات (views/notifications.ejs) وشريط التنقل (views/partials/navbar.ejs) لتطابق crm.fast-order-eg.tech تماماً <!-- id: 33 -->
- [ ] 5. إضافة مسارات الويب بوش والإشعارات في routes/dashboard.js وتحديث server.js لمزامنة جدول push_subscriptions <!-- id: 34 -->
- [ ] 6. ربط استقبال رسائل العملاء في botController.js لإرسال إشعار فوري (Web Push + Socket) للموظف المعين للعميل (أو الأدمن) <!-- id: 35 -->
- [ ] 7. فحص التعديلات ورفعها للسيرفر بنظام الزيرو داون تايم عبر deploy.ps1 <!-- id: 36 -->
