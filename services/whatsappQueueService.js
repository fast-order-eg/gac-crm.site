/**
 * WhatsApp Outbound Message Queue Service
 * --------------------------------------
 * نظام طابور الإرسال الموحد لمحاكاة السلوك البشري وحماية رقم الواتساب من الحظر (Anti-Ban FIFO Queue).
 * 
 * المزايا:
 * 1. معالجة تسلسلية (FIFO): يمنع إرسال رسائل متعددة في نفس الجزء من الثانية.
 * 2. قراءة الرسائل (الصحين الزرق readMessages) داخل الطابور فقط عندما يحين دور العميل (وليس لكل العملاء في نفس اللحظة).
 * 3. محاكاة القراءة والتفكير بعد فتح المحادثة قبل البدء في الكتابة (Thinking Delay).
 * 4. إظهار حالة "يكتب الآن..." (composing) أو "يسجل مقطع صوتي..." (recording) وحساب المدة بحسب طول الرسالة.
 * 5. تجديد إشارة "يكتب الآن" دورياً لتظل ظاهرة طوال مدة الكتابة.
 * 6. تنويع البصمة الرقمية للنصوص (Anti-Hash Text Variation) لمنع تطابق الهاش في سيرفرات واتساب.
 * 7. فاصل زمني إنساني عشوائي (Cooldown) بين المحادثات في الطابور لمنع الـ Bursting.
 */

const INVISIBLE_CHARS = ['\u200B', '\u200C', '\u200D', '\uFEFF'];

class WhatsAppQueue {
    constructor() {
        this.queue = [];
        this.isProcessing = false;

        // تخزين مفاتيح الرسائل غير المقروءة لكل عميل ليتم وضع "الصحين الزرق" فقط عندما يحين دوره في الطابور
        this.pendingReadKeys = new Map();

        // إعدادات محاكاة الكتابة البشرية (بالمللي ثانية)
        this.minTypingMs = 3500;       // أقل مدة كتابة (3.5 ثوانٍ)
        this.maxTypingMs = 22000;      // أقصى مدة كتابة للرسائل الطويلة (22 ثانية)
        this.msPerChar = 95;           // متوسط كتابة الحرف الواحد (95ms)
        this.thinkingMinMs = 1800;     // أقل مدة قراءة وتفكير بعد فتح الشات (1.8 ثانية)
        this.thinkingMaxMs = 3500;     // أقصى مدة تفكير (3.5 ثوانٍ)
        this.cooldownMinMs = 4000;     // أقل فاصل زمني بين محادثة والأخرى (4 ثوانٍ)
        this.cooldownMaxMs = 7500;     // أقصى فاصل زمني بين المحادثات (7.5 ثوانٍ)
    }

    /**
     * تسجيل مفتاح رسالة واردة ليتم عمل "صحين زرق" (readMessages) لها عندما يفتح البوت المحادثة في الطابور
     * @param {string} remoteJid - معرف العميل المحلول
     * @param {Object} msgKey - مفتاح الرسالة من Baileys (msg.key)
     */
    queueReadKey(remoteJid, msgKey) {
        if (!msgKey) return;
        const jids = new Set();
        if (remoteJid) jids.add(remoteJid);
        if (msgKey.remoteJid) jids.add(msgKey.remoteJid);
        if (msgKey.remoteJidAlt) jids.add(msgKey.remoteJidAlt);

        for (const jid of jids) {
            const list = this.pendingReadKeys.get(jid) || [];
            if (!list.some(k => k.id === msgKey.id)) {
                list.push(msgKey);
                // الاحتفاظ بآخر 15 رسالة كحد أقصى لكل محادثة لمنع تراكم الذاكرة
                if (list.length > 15) list.shift();
                this.pendingReadKeys.set(jid, list);
            }
        }
    }

    /**
     * استخراج ومسح مفاتيح الرسائل غير المقروءة الخاصة بمحادثة معينة
     */
    consumeReadKeys(remoteJid) {
        const keys = this.pendingReadKeys.get(remoteJid) || [];
        this.pendingReadKeys.delete(remoteJid);
        // مسح نفس المفاتيح من أي JID بديل (مثل @lid)
        if (keys.length > 0) {
            const keyIds = new Set(keys.map(k => k.id));
            for (const [otherJid, otherList] of this.pendingReadKeys.entries()) {
                const filtered = otherList.filter(k => !keyIds.has(k.id));
                if (filtered.length === 0) {
                    this.pendingReadKeys.delete(otherJid);
                } else if (filtered.length !== otherList.length) {
                    this.pendingReadKeys.set(otherJid, filtered);
                }
            }
        }
        return keys;
    }

    /**
     * تنويع البصمة الرقمية للنص (Anti-Hash Text Spintax)
     * يضيف محارف غير مرئية ومسافات طفيفة بحيث لا تتطابق بصمة (SHA-256 Hash) الرسائل المتكررة عند واتساب
     * دون أن يتغير شكل الرسالة أمام عين العميل نهائياً.
     */
    diversifyTextFingerprint(text) {
        if (!text || typeof text !== 'string') return text;

        let result = text;

        // 1. إدراج محرف غير مرئي عشوائي عند بعض المسافات بين الكلمات
        const words = result.split(' ');
        if (words.length > 2) {
            const insertions = Math.min(3, Math.floor(words.length / 2));
            for (let i = 0; i < insertions; i++) {
                const randomIndex = Math.floor(Math.random() * (words.length - 1));
                const randChar = INVISIBLE_CHARS[Math.floor(Math.random() * INVISIBLE_CHARS.length)];
                words[randomIndex] = words[randomIndex] + randChar;
            }
            result = words.join(' ');
        }

        // 2. إضافة سلسلة فريدة غير مرئية في نهاية الرسالة لتغيير الطول والهاش الكلي
        const suffixCount = Math.floor(Math.random() * 4) + 2; // 2 إلى 5 محارف غير مرئية
        let invisibleSuffix = '';
        for (let i = 0; i < suffixCount; i++) {
            invisibleSuffix += INVISIBLE_CHARS[Math.floor(Math.random() * INVISIBLE_CHARS.length)];
        }
        const trailingSpaces = ' '.repeat(Math.floor(Math.random() * 2)); // 0 أو 1 مسافة

        return result + invisibleSuffix + trailingSpaces;
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

            // 1. تحديث الحالة إلى متصل (available) لفتح المحادثة
            try {
                await sock.sendPresenceUpdate('available', remoteJid);
            } catch (pErr) {}

            // 2. وضع علامة القراءة (الصحين الزرق readMessages) الآن فقط عندما جاء دور العميل في الطابور!
            const keysToRead = this.consumeReadKeys(remoteJid);
            if (options.readKey && !keysToRead.some(k => k.id === options.readKey.id)) {
                keysToRead.push(options.readKey);
            }
            if (keysToRead.length > 0 && typeof sock.readMessages === 'function') {
                try {
                    await sock.readMessages(keysToRead);
                    console.log(`👀 [WhatsAppQueue] تم وضع علامة القراءة (صحين زرق) لـ ${keysToRead.length} رسالة من ${remoteJid}`);
                } catch (readErr) {
                    console.error(`⚠️ [WhatsAppQueue] خطأ في readMessages لـ ${remoteJid}:`, readErr?.message || readErr);
                }
            }

            // 3. زمن القراءة والتفكير بعد ظهور الصحين الزرق وقبل البدء في الكتابة (1.8 إلى 3.5 ثوانٍ)
            const thinkingTime = Math.floor(Math.random() * (this.thinkingMaxMs - this.thinkingMinMs) + this.thinkingMinMs);
            await new Promise(r => setTimeout(r, thinkingTime));

            // 4. تحديد نوع المحاكاة: تسجيل صوتي أم كتابة نصية
            const isAudio = content.audio || (content.mimetype && content.mimetype.startsWith('audio/')) || !!content.audioMessage;
            const presenceState = isAudio ? 'recording' : 'composing';

            // 5. حساب مدة الكتابة بناءً على عدد الحروف الفعلي
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

            // 6. تنويع البصمة الرقمية للنص قبل الإرسال الفعلي (دون المساس بالنص الأصلي المحفوظ في قاعدة البيانات)
            const outboundContent = { ...content };
            if (outboundContent.text) {
                outboundContent.text = this.diversifyTextFingerprint(outboundContent.text);
            }
            if (outboundContent.caption) {
                outboundContent.caption = this.diversifyTextFingerprint(outboundContent.caption);
            }

            // 7. إرسال الرسالة الفعلية
            const { userId, io, saveToDb, readKey, ...msgOptions } = options;
            const sentMsg = await sock.sendMessage(remoteJid, outboundContent, msgOptions);
            console.log(`✅ [WhatsAppQueue] تم إرسال الرسالة بنجاح إلى ${remoteJid} (ببصمة نصية فريدة)`);

            // 8. إنهاء حالة الكتابة: paused ثم unavailable
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
            // 9. المعيار الذهبي لمكافحة الحظر: الفاصل الزمني (Cooldown) قبل أخذ المحادثة التالية في الطابور
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
