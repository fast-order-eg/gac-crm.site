/**
 * WhatsApp Outbound Message Queue Service
 * --------------------------------------
 * نظام طابور الإرسال الموحد لمحاكاة السلوك البشري وحماية رقم الواتساب من الحظر (Anti-Ban FIFO Queue).
 * 
 * المزايا:
 * 1. معالجة تسلسلية (FIFO): يمنع إرسال رسائل متعددة في نفس الجزء من الثانية.
 * 2. محاكاة القراءة والتفكير قبل الرد (Thinking Delay).
 * 3. إظهار حالة "يكتب الآن..." (composing) أو "يسجل مقطع صوتي..." (recording) وحساب المدة بحسب طول الرسالة.
 * 4. تجديد إشارة "يكتب الآن" دورياً لتظل ظاهرة طوال مدة الكتابة.
 * 5. فاصل زمني إنساني عشوائي (Cooldown) بين المحادثات في الطابور لمنع الـ Bursting.
 */

class WhatsAppQueue {
    constructor() {
        this.queue = [];
        this.isProcessing = false;

        // إعدادات محاكاة الكتابة البشرية (بالمللي ثانية)
        this.minTypingMs = 3500;       // أقل مدة كتابة (3.5 ثوانٍ)
        this.maxTypingMs = 22000;      // أقصى مدة كتابة للرسائل الطويلة (22 ثانية)
        this.msPerChar = 95;           // متوسط كتابة الحرف الواحد (95ms)
        this.thinkingMinMs = 1500;     // أقل مدة تفكير وقراءة (1.5 ثانية)
        this.thinkingMaxMs = 3000;     // أقصى مدة تفكير (3 ثوانٍ)
        this.cooldownMinMs = 3500;     // أقل فاصل زمني بين محادثة والأخرى (3.5 ثانية)
        this.cooldownMaxMs = 6500;     // أقصى فاصل زمني بين المحادثات (6.5 ثانية)
    }

    /**
     * إضافة رسالة جديدة إلى طابور الإرسال
     * @param {Object} sock - كائن اتصال Baileys
     * @param {string} remoteJid - معرف المستلم (عميل أو جروب)
     * @param {Object} content - محتوى الرسالة (text, image, audio, caption, إلخ)
     * @param {Object} options - خيارات إضافية (saveToDb, userId, io, إلخ)
     * @returns {Promise} يُرجع نتيجة الإرسال بعد اكتمال المحاكاة والإرسال
     */
    enqueue(sock, remoteJid, content, options = {}) {
        return new Promise((resolve, reject) => {
            this.queue.push({
                sock,
                remoteJid,
                content,
                options,
                resolve,
                reject,
                enqueuedAt: Date.now()
            });

            console.log(`📥 [WhatsAppQueue] أضيفت رسالة جديدة إلى الطابور لـ ${remoteJid}. (العدد الحالي بالطابور: ${this.queue.length})`);
            this.process();
        });
    }

    /**
     * المعالجة التسلسلية لعناصر الطابور
     */
    async process() {
        if (this.isProcessing) return;
        if (this.queue.length === 0) return;

        this.isProcessing = true;
        const currentTask = this.queue.shift();
        const { sock, remoteJid, content, options, resolve, reject } = currentTask;

        try {
            if (!sock || typeof sock.sendMessage !== 'function') {
                throw new Error('كائن الاتصال sock غير متاح أو مفصول.');
            }

            // 1. زمن التفكير والقراءة قبل البدء في الكتابة (1.5 إلى 3 ثوانٍ)
            const thinkingTime = Math.floor(Math.random() * (this.thinkingMaxMs - this.thinkingMinMs) + this.thinkingMinMs);
            await new Promise(r => setTimeout(r, thinkingTime));

            // 2. تحديث الحالة إلى متصل (available)
            try {
                await sock.sendPresenceUpdate('available', remoteJid);
            } catch (pErr) {
                // تجاهل أخطاء الـ presence المؤقتة
            }

            // 3. تحديد نوع المحاكاة: تسجيل صوتي أم كتابة نصية
            const isAudio = content.audio || (content.mimetype && content.mimetype.startsWith('audio/')) || !!content.audioMessage;
            const presenceState = isAudio ? 'recording' : 'composing';

            // 4. حساب مدة الكتابة بناءً على عدد الحروف الفعلي
            let textLength = 0;
            if (content.text) {
                textLength = content.text.length;
            } else if (content.caption) {
                textLength = content.caption.length;
            } else if (content.image || content.video) {
                textLength = 35; // محاكاة وقت رفع وتجهيز الوسائط
            }

            // المعادلة: Base + (الحروف * 95ms) + تذبذب عشوائي
            const baseMs = 2500;
            const jitterMs = Math.floor(Math.random() * 2000);
            const calculatedMs = baseMs + (textLength * this.msPerChar) + jitterMs;
            const typingDuration = Math.max(this.minTypingMs, Math.min(this.maxTypingMs, calculatedMs));

            console.log(`✍️ [WhatsAppQueue] جاري محاكاة "${presenceState}" لـ ${remoteJid} لمدة ${(typingDuration / 1000).toFixed(1)} ثانية (طول النص: ${textLength} حرف - المتبقي بالطابور: ${this.queue.length})`);

            // بدء إظهار حالة الكتابة وتجديدها كل 4.5 ثوانٍ لأن واتساب يلغيها تلقائياً بعد 6 ثوانٍ
            try {
                await sock.sendPresenceUpdate(presenceState, remoteJid);
            } catch (pErr) {}

            const startTime = Date.now();
            while (Date.now() - startTime < typingDuration) {
                const remaining = typingDuration - (Date.now() - startTime);
                const chunk = Math.min(4500, remaining);
                await new Promise(r => setTimeout(r, chunk));
                if (Date.now() - startTime < typingDuration) {
                    try {
                        await sock.sendPresenceUpdate(presenceState, remoteJid);
                    } catch (pErr) {}
                }
            }

            // 5. إرسال الرسالة الفعلية
            const { userId, io, saveToDb, ...msgOptions } = options;
            const sentMsg = await sock.sendMessage(remoteJid, content, msgOptions);
            console.log(`✅ [WhatsAppQueue] تم إرسال الرسالة بنجاح إلى ${remoteJid}`);

            // 6. إنهاء حالة الكتابة: paused ثم unavailable
            try {
                await sock.sendPresenceUpdate('paused', remoteJid);
                setTimeout(async () => {
                    try {
                        await sock.sendPresenceUpdate('unavailable', remoteJid);
                    } catch (e) {}
                }, 1200);
            } catch (pErr) {}

            resolve(sentMsg);
        } catch (err) {
            console.error(`❌ [WhatsAppQueue] خطأ أثناء إرسال الرسالة إلى ${remoteJid}:`, err?.message || err);
            reject(err);
        } finally {
            // 7. المعيار الذهبي لمكافحة الحظر: الفاصل الزمني (Cooldown) قبل أخذ المحادثة التالية في الطابور
            if (this.queue.length > 0) {
                const cooldown = Math.floor(Math.random() * (this.cooldownMaxMs - this.cooldownMinMs) + this.cooldownMinMs);
                console.log(`⏳ [WhatsAppQueue] انتظار فاصل أمان إنساني لمدة ${(cooldown / 1000).toFixed(1)} ثانية قبل الانتقال للرسالة التالية في الطابور...`);
                await new Promise(r => setTimeout(r, cooldown));
            }

            this.isProcessing = false;
            // الانتقال للرسالة التالية
            this.process();
        }
    }

    /**
     * معرفة عدد الرسائل المتبقية في الطابور حالياً
     */
    getPendingCount() {
        return this.queue.length;
    }
}

export const whatsappQueue = new WhatsAppQueue();
