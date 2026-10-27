import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import os from 'os';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import { getSetting } from './settingsService.js';

ffmpeg.setFfmpegPath(ffmpegPath);

const GRAPH_API_VERSION = 'v21.0';

/**
 * جلب إعدادات واتساب ميتا من قاعدة البيانات (أو .env كـ Fallback)
 */
export async function getMetaConfig(userId = 1) {
    const defaultToken = 'EAGPOauTuiMABS8t4epW190BdWfNgPRn31bGLoHbw9eWnUlZA3ZBF1IHtndneCqQppHzYMtZCxn2NcVJemfdSteatm7zUwFEY35oDOTR3dArcscUiN0FIinrO6QClEBqxfRHdfQSdKGoCEaT2JYdflGFmSn9qsAWQqROtS2wZB4ZAUGIPAemGE3PLTc1svIg5qdQZDZD';
    const defaultPhoneId = '1452465954607485';
    const defaultWabaId = '1166724729014816';
    const defaultVerifyToken = 'gac_crm_meta_wh_2026';
    const defaultDisplayNumber = '+201035917094';

    try {
        const enabledDb = await getSetting('meta_whatsapp_enabled', userId);
        const phoneIdDb = await getSetting('meta_phone_number_id', userId);
        const wabaIdDb = await getSetting('meta_waba_id', userId);
        const tokenDb = await getSetting('meta_whatsapp_token', userId);
        const verifyTokenDb = await getSetting('meta_verify_token', userId);
        const displayNumberDb = await getSetting('meta_display_number', userId);
        const appSecretDb = await getSetting('meta_app_secret', userId);

        return {
            enabled: enabledDb !== false && enabledDb !== 'false',
            phoneNumberId: phoneIdDb || process.env.META_PHONE_NUMBER_ID || defaultPhoneId,
            wabaId: wabaIdDb || process.env.META_WABA_ID || defaultWabaId,
            token: tokenDb || process.env.META_WHATSAPP_TOKEN || defaultToken,
            verifyToken: verifyTokenDb || process.env.META_VERIFY_TOKEN || defaultVerifyToken,
            displayNumber: (displayNumberDb || defaultDisplayNumber).replace(/\s+/g, ''),
            appSecret: appSecretDb || process.env.META_APP_SECRET || ''
        };
    } catch (err) {
        return {
            enabled: true,
            phoneNumberId: process.env.META_PHONE_NUMBER_ID || defaultPhoneId,
            wabaId: process.env.META_WABA_ID || defaultWabaId,
            token: process.env.META_WHATSAPP_TOKEN || defaultToken,
            verifyToken: process.env.META_VERIFY_TOKEN || defaultVerifyToken,
            displayNumber: defaultDisplayNumber,
            appSecret: process.env.META_APP_SECRET || ''
        };
    }
}

/**
 * فحص الاتصال بسيرفرات ميتا والتحقق من صحة التوكن ورقم الهاتف
 */
export async function testMetaConnection(configOverride = null) {
    try {
        const config = configOverride || await getMetaConfig(1);
        if (!config.token) {
            return { success: false, message: 'رمز الوصول الدائم (Token) غير متوفر.' };
        }
        if (!config.phoneNumberId) {
            return { success: false, message: 'معرّف رقم الهاتف (Phone Number ID) غير متوفر.' };
        }

        const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${config.phoneNumberId}?access_token=${config.token}`;
        const resp = await fetch(url);
        const data = await resp.json();

        if (data.error) {
            return {
                success: false,
                message: data.error.message || 'خطأ في الاتصال بسيرفرات ميتا',
                error: data.error
            };
        }

        // التأكد التلقائي من ربط واشتراك حساب WABA بالتطبيق لاستقبال رسائل الويب هوك
        let wabaSubscribed = false;
        if (config.wabaId) {
            try {
                const subUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/${config.wabaId}/subscribed_apps?access_token=${config.token}`;
                const subResp = await fetch(subUrl, { method: 'POST' });
                const subData = await subResp.json();
                wabaSubscribed = subData.success === true;
            } catch (subErr) {
                console.warn('⚠️ [Meta WABA Auto-Subscribe Warn]:', subErr.message);
            }
        }

        return {
            success: true,
            message: 'تم الاتصال بسيرفرات ميتا بنجاح!',
            data: {
                id: data.id,
                verifiedName: data.verified_name || data.display_phone_number,
                displayPhoneNumber: data.display_phone_number,
                qualityRating: data.quality_rating,
                status: data.code_verification_status,
                wabaSubscribed
            }
        };
    } catch (err) {
        return {
            success: false,
            message: err.message || 'فشل الاتصال بشبكة الإنترنت أو سيرفرات ميتا'
        };
    }
}

/**
 * تنظيف وتنسيق رقم الهاتف لإرساله لميتا (إزالة + وأي مسافات و @s.whatsapp.net)
 */
export function cleanPhoneNumber(phoneOrJid) {
    if (!phoneOrJid) return '';
    let cleaned = String(phoneOrJid).trim();
    if (cleaned.includes('@')) {
        cleaned = cleaned.split('@')[0];
    }
    cleaned = cleaned.replace(/\D/g, '');
    return cleaned;
}

/**
 * إرسال رسالة نصية عبر Meta WhatsApp Cloud API
 */
export async function sendMetaTextMessage(toPhoneOrJid, textBody, options = {}) {
    const config = await getMetaConfig(options.userId || 1);
    if (!config.enabled || !config.token || !config.phoneNumberId) {
        throw new Error('خدمة واتساب ميتا كلاود غير مفعلة أو لم يتم ضبط بيانات الـ API.');
    }

    const cleanPhone = cleanPhoneNumber(toPhoneOrJid);
    if (!cleanPhone) throw new Error('رقم الهاتف غير صالح للإرسال.');

    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${config.phoneNumberId}/messages`;

    const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: cleanPhone,
        type: 'text',
        text: {
            preview_url: true,
            body: textBody
        }
    };

    // دعم الرد المقتبس إن وجد (Context Quoted Reply)
    if (options.quotedMsgId) {
        payload.context = {
            message_id: options.quotedMsgId
        };
    }

    const resp = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${config.token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });

    const data = await resp.json();
    if (data.error) {
        console.error('❌ [Meta WhatsApp API Error - Send Text]:', data.error);
        throw new Error(data.error.message || 'فشل إرسال الرسالة عبر ميتا.');
    }

    return {
        success: true,
        messageId: data.messages?.[0]?.id,
        raw: data
    };
}

/**
 * إرسال وسائط (صورة، فويس، فيديو، مستند) عبر Meta WhatsApp Cloud API
 */
export async function sendMetaMediaMessage(toPhoneOrJid, mediaUrl, mediaType, caption = '', options = {}) {
    const config = await getMetaConfig(options.userId || 1);
    if (!config.enabled || !config.token || !config.phoneNumberId) {
        throw new Error('خدمة واتساب ميتا كلاود غير مفعلة.');
    }

    const cleanPhone = cleanPhoneNumber(toPhoneOrJid);
    if (!cleanPhone) throw new Error('رقم الهاتف غير صالح للإرسال.');

    // تجهيز الرابط العام الكامل للوسائط
    let fullMediaUrl = mediaUrl;
    if (!fullMediaUrl.startsWith('http://') && !fullMediaUrl.startsWith('https://')) {
        const baseUrl = process.env.BASE_URL || 'https://gac-crm.site';
        fullMediaUrl = `${baseUrl.replace(/\/$/, '')}${mediaUrl.startsWith('/') ? '' : '/'}${mediaUrl}`;
    }

    let metaType = 'document';
    const lowerType = (mediaType || '').toLowerCase();
    const ext = path.extname(mediaUrl).toLowerCase().replace('.', '');

    if (lowerType.startsWith('image/') || ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) {
        metaType = 'image';
    } else if (lowerType.startsWith('audio/') || ['mp3', 'ogg', 'wav', 'm4a', 'opus'].includes(ext)) {
        metaType = 'audio';
    } else if (lowerType.startsWith('video/') || ['mp4', 'mov', 'webm'].includes(ext)) {
        metaType = 'video';
    }

    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${config.phoneNumberId}/messages`;

    const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: cleanPhone,
        type: metaType
    };

    if (metaType === 'image') {
        payload.image = { link: fullMediaUrl };
        if (caption) payload.image.caption = caption;
    } else if (metaType === 'audio') {
        payload.audio = { link: fullMediaUrl };
    } else if (metaType === 'video') {
        payload.video = { link: fullMediaUrl };
        if (caption) payload.video.caption = caption;
    } else {
        const filename = path.basename(mediaUrl) || 'document';
        payload.document = { link: fullMediaUrl, filename };
        if (caption) payload.document.caption = caption;
    }

    if (options.quotedMsgId) {
        payload.context = { message_id: options.quotedMsgId };
    }

    const resp = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${config.token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });

    const data = await resp.json();
    if (data.error) {
        console.error('❌ [Meta WhatsApp API Error - Send Media]:', data.error);
        throw new Error(data.error.message || 'فشل إرسال الوسائط عبر ميتا.');
    }

    return {
        success: true,
        messageId: data.messages?.[0]?.id,
        raw: data
    };
}

/**
 * إرسال تفاعل إيموجي (Reaction) على رسالة في واتساب ميتا
 */
export async function sendMetaReaction(toPhoneOrJid, messageId, emoji = '', options = {}) {
    const config = await getMetaConfig(options.userId || 1);
    if (!config.enabled || !config.token || !config.phoneNumberId) return;

    const cleanPhone = cleanPhoneNumber(toPhoneOrJid);
    if (!cleanPhone || !messageId) return;

    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${config.phoneNumberId}/messages`;

    const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: cleanPhone,
        type: 'reaction',
        reaction: {
            message_id: messageId,
            emoji: emoji || ''
        }
    };

    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${config.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });
        const data = await resp.json();
        return { success: !data.error, data };
    } catch (e) {
        console.error('Error sending meta reaction:', e);
    }
}

/**
 * وضع علامة مقروء (Read Receipts) على رسالة العميل
 */
export async function markMetaMessageAsRead(messageId, options = {}) {
    try {
        const config = await getMetaConfig(options.userId || 1);
        if (!config.enabled || !config.token || !config.phoneNumberId || !messageId) return;

        const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${config.phoneNumberId}/messages`;
        await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${config.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                status: 'read',
                message_id: messageId
            })
        });
    } catch (e) {
        // قراءة الرسالة صامتة ولا تؤثر على التدفق
    }
}

/**
 * تحميل وسائط العميل الواردة من ميتا وحفظها محلياً (مع تحويل الفويس لـ MP3)
 */
export async function downloadMetaMediaFile(mediaId, userId = 1, mimeHint = '') {
    try {
        const config = await getMetaConfig(userId);
        if (!config.token || !mediaId) return null;

        // 1. جلب رابط التحميل المؤقت من ميتا
        const metaMediaUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/${mediaId}`;
        const metaMediaResp = await fetch(metaMediaUrl, {
            headers: { 'Authorization': `Bearer ${config.token}` }
        });
        const metaMediaData = await metaMediaResp.json();

        if (!metaMediaData.url) {
            console.error('❌ Could not retrieve media URL from Meta:', metaMediaData);
            return null;
        }

        // 2. تحميل محتوى الملف (Buffer)
        const fileResp = await fetch(metaMediaData.url, {
            headers: { 'Authorization': `Bearer ${config.token}` }
        });
        const fileBuffer = await fileResp.buffer();

        const mediaDir = path.join(process.cwd(), 'public', 'uploads', 'media', String(userId));
        if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });

        const mimeType = metaMediaData.mime_type || mimeHint || 'application/octet-stream';
        const isAudio = mimeType.startsWith('audio/');
        const isImage = mimeType.startsWith('image/');
        const isVideo = mimeType.startsWith('video/');

        if (isAudio) {
            const baseName = `audio_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
            const mp3Path = path.join(mediaDir, `${baseName}.mp3`);
            const tempInput = path.join(os.tmpdir(), `temp_meta_${Date.now()}_${Math.floor(Math.random() * 1000)}.ogg`);

            try {
                fs.writeFileSync(tempInput, fileBuffer);
                await new Promise((resolve, reject) => {
                    ffmpeg(tempInput)
                        .toFormat('mp3')
                        .audioCodec('libmp3lame')
                        .audioBitrate(128)
                        .on('end', resolve)
                        .on('error', reject)
                        .save(mp3Path);
                });
                return `/uploads/media/${userId}/${baseName}.mp3`;
            } catch (convErr) {
                console.error('FFmpeg conversion error on meta audio, saving raw:', convErr);
                const rawPath = path.join(mediaDir, `${baseName}.ogg`);
                fs.writeFileSync(rawPath, fileBuffer);
                return `/uploads/media/${userId}/${baseName}.ogg`;
            } finally {
                if (fs.existsSync(tempInput)) {
                    try { fs.unlinkSync(tempInput); } catch (e) {}
                }
            }
        }

        let ext = 'bin';
        if (isImage) ext = mimeType.includes('png') ? 'png' : 'jpg';
        else if (isVideo) ext = 'mp4';
        else if (mimeType.includes('pdf')) ext = 'pdf';

        const fileName = `media_${Date.now()}_${Math.floor(Math.random() * 1000)}.${ext}`;
        const filePath = path.join(mediaDir, fileName);
        fs.writeFileSync(filePath, fileBuffer);

        return `/uploads/media/${userId}/${fileName}`;
    } catch (err) {
        console.error('Error downloading Meta media:', err);
        return null;
    }
}
