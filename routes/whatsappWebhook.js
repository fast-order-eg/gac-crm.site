import express from 'express';
import { getSetting } from '../services/settingsService.js';
import { downloadMetaMediaFile, markMetaMessageAsRead, sendMetaTextMessage } from '../services/metaWhatsappService.js';
import Customer from '../models/Customer.js';
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import User from '../models/User.js';
import { Op } from 'sequelize';
import { assignCustomerToSales } from '../services/assignmentService.js';
import { createNotification } from '../services/notificationService.js';

const router = express.Router();

// Helper: دالة التحقق من الويب هوك المطلوبة من ميتا (Webhook Verification)
async function verifyWebhookHandler(req, res) {
    try {
        const mode = req.query['hub.mode'];
        const token = req.query['hub.verify_token'];
        const challenge = req.query['hub.challenge'];

        let configuredToken = process.env.META_VERIFY_TOKEN;
        try {
            const dbToken = await getSetting('meta_verify_token', 1);
            if (dbToken) configuredToken = dbToken;
        } catch (e) {}

        const isValidToken = token === 'gac_crm_meta_wh_2026' || token === 'fastorder_meta_verify_2026' || (configuredToken && token === configuredToken);

        if (mode === 'subscribe' && isValidToken) {
            console.log('✅ [WhatsApp Webhook] Verified successfully with Meta challenge!');
            return res.status(200).send(challenge);
        }

        console.warn('⚠️ [WhatsApp Webhook] Verification mismatch. Mode:', mode, 'Token:', token);
        return res.status(403).send('Verification token mismatch');
    } catch (err) {
        console.error('❌ [WhatsApp Webhook] Verification error:', err);
        return res.status(500).send('Internal Server Error');
    }
}

// GET: دعم كلا المسارين (/webhook/whatsapp و /api/whatsapp/meta-webhook مثل crm.fast-order-eg.tech)
router.get('/webhook/whatsapp', verifyWebhookHandler);
router.get('/api/whatsapp/meta-webhook', verifyWebhookHandler);

// POST: دالة استقبال ومعالجة أحداث ورسائل الواتساب من ميتا (Webhook Events)
async function handleWebhookPost(req, res) {
    console.log('📩 [Meta Webhook POST Received]:', JSON.stringify(req.body));
    // 1. الرد الفوري بـ 200 لتجنب إعادة المحاولات من سيرفرات ميتا
    res.sendStatus(200);

    const body = req.body;
    if (body.object !== 'whatsapp_business_account' || !body.entry) {
        return;
    }

    try {
        const io = req.app.get('socketio');

        for (const entry of body.entry) {
            const changes = entry.changes || [];
            for (const change of changes) {
                if (change.field !== 'messages') continue;
                const value = change.value;
                if (!value) continue;

                // 2. معالجة تحديثات حالة الرسائل (Delivered / Read / Failed)
                if (value.statuses && Array.isArray(value.statuses)) {
                    for (const st of value.statuses) {
                        const mid = st.id;
                        const status = st.status; // sent, delivered, read, failed
                        if (mid && status) {
                            try {
                                await Message.update({ status }, { where: { messageId: mid } });
                            } catch (e) {}
                        }
                    }
                }

                // 3. معالجة الرسائل الواردة من العملاء
                if (value.messages && Array.isArray(value.messages)) {
                    for (const msg of value.messages) {
                        await processIncomingMetaMessage(msg, value.contacts, io);
                    }
                }
            }
        }
    } catch (err) {
        console.error('❌ [WhatsApp Cloud Webhook] Global processing error:', err);
    }
}

// POST: دعم كلا المسارين
router.post('/webhook/whatsapp', handleWebhookPost);
router.post('/api/whatsapp/meta-webhook', handleWebhookPost);

/**
 * معالجة رسالة واردة واحدة من واتساب ميتا كلاود
 */
async function processIncomingMetaMessage(msg, contacts = [], io = null) {
    try {
        const senderPhone = String(msg.from || '').trim();
        if (!senderPhone) return;

        const remoteJid = `${senderPhone}@s.whatsapp.net`;
        const messageId = msg.id;

        // 1. منع التكرار: التأكد من عدم معالجة هذه الرسالة مسبقاً
        const existingMsg = await Message.findOne({ where: { messageId } });
        if (existingMsg) {
            console.log(`⚠️ [WhatsApp Webhook] Message ${messageId} already exists, skipping.`);
            return;
        }

        // استخراج الاسم من الملف الشخصي لواتساب
        const contactObj = (contacts || []).find(c => c.wa_id === senderPhone);
        const profileName = contactObj?.profile?.name || null;

        // 2. استخراج أو إنشاء العميل (Customer)
        let customer = await Customer.findOne({
            where: {
                [Op.or]: [
                    { remoteJid },
                    { phoneNumber: senderPhone }
                ]
            }
        });

        let defaultAdmin = await User.findOne({ where: { role: 'admin' } });
        if (!defaultAdmin) defaultAdmin = await User.findOne({ where: { role: 'super_admin' } });
        const defaultAdminId = defaultAdmin ? defaultAdmin.id : 1;

        if (!customer) {
            let assignedUserId = defaultAdminId;
            try {
                const assignedEmp = await assignCustomerToSales(null, defaultAdminId);
                if (assignedEmp && assignedEmp.id) assignedUserId = assignedEmp.id;
            } catch (e) {}

            customer = await Customer.create({
                customerName: profileName || senderPhone,
                phoneNumber: senderPhone,
                remoteJid,
                stage: 'lead',
                channel: 'whatsapp_meta',
                UserId: assignedUserId,
                isBotActive: true,
                isManualOverride: false,
                lastInteraction: new Date()
            });
            console.log(`👤 [WhatsApp Meta] New customer created: ${customer.customerName} (${customer.phoneNumber})`);
        } else {
            let updated = false;
            if (profileName && (!customer.customerName || customer.customerName === senderPhone)) {
                customer.customerName = profileName;
                updated = true;
            }
            customer.lastInteraction = new Date();
            customer.scheduledFollowUpAt = null;
            await customer.save();
        }

        const targetUserId = customer.UserId || defaultAdminId;

        // 3. معالجة محتوى الرسالة ونوعها والوسائط
        let text = '';
        let mediaUrl = null;
        const msgType = msg.type;

        if (msgType === 'text') {
            text = msg.text?.body || '';
        } else if (msgType === 'image') {
            const caption = msg.image?.caption || '';
            text = caption ? `📷 صورة: ${caption}` : '📷 صورة';
            mediaUrl = await downloadMetaMediaFile(msg.image?.id, targetUserId, msg.image?.mime_type);
        } else if (msgType === 'audio') {
            text = 'رسالة صوتية 🎙️';
            mediaUrl = await downloadMetaMediaFile(msg.audio?.id, targetUserId, msg.audio?.mime_type);
        } else if (msgType === 'video') {
            const caption = msg.video?.caption || '';
            text = caption ? `🎥 فيديو: ${caption}` : '🎥 فيديو';
            mediaUrl = await downloadMetaMediaFile(msg.video?.id, targetUserId, msg.video?.mime_type);
        } else if (msgType === 'document') {
            const filename = msg.document?.filename || 'مستند';
            const caption = msg.document?.caption || '';
            text = caption ? `📄 ${filename}: ${caption}` : `📄 ${filename}`;
            mediaUrl = await downloadMetaMediaFile(msg.document?.id, targetUserId, msg.document?.mime_type);
        } else if (msgType === 'reaction') {
            // تفاعل إيموجي على رسالة سابقة
            const targetWamid = msg.reaction?.message_id;
            const emoji = msg.reaction?.emoji || null;
            if (targetWamid) {
                const targetMessage = await Message.findOne({ where: { messageId: targetWamid } });
                if (targetMessage) {
                    targetMessage.reaction = emoji;
                    await targetMessage.save();
                    if (io) {
                        io.to('crm_staff').emit('message_reaction', {
                            messageId: targetMessage.id,
                            wamid: targetWamid,
                            remoteJid,
                            emoji
                        });
                    }
                }
            }
            return;
        } else {
            text = `[رسالة من نوع ${msgType}]`;
        }

        // 4. استخراج معلومات الرد المقتبس إن وجدت (Context Quoted Msg)
        let quotedMsgId = null;
        let quotedContent = null;
        let quotedSender = null;
        if (msg.context?.id) {
            const qMsg = await Message.findOne({ where: { messageId: msg.context.id } });
            if (qMsg) {
                quotedMsgId = qMsg.id;
                quotedContent = qMsg.content || (qMsg.media_url ? 'مرفق' : '');
                quotedSender = qMsg.role === 'model' ? 'أنت' : 'العميل';
            }
        }

        // 5. حفظ الرسالة في جدول messages
        const savedMsg = await Message.create({
            UserId: targetUserId,
            remoteJid,
            role: 'user',
            content: text,
            media_url: mediaUrl,
            messageId,
            quotedMsgId,
            quotedContent,
            quotedSender,
            status: 'received'
        });

        // 6. تحديث أو إنشاء المحادثة (Conversation)
        let conv = await Conversation.findOne({
            where: {
                [Op.or]: [
                    { remoteJid },
                    { phoneNumber: senderPhone }
                ]
            }
        });

        if (conv) {
            conv.lastMessage = text;
            conv.lastMessageText = text;
            conv.lastMessageTime = new Date();
            conv.lastMessageAt = new Date();
            conv.unreadCount = (conv.unreadCount || 0) + 1;
            if (profileName && (!conv.customerName || conv.customerName === senderPhone)) {
                conv.customerName = profileName;
            }
            await conv.save();
        } else {
            conv = await Conversation.create({
                UserId: targetUserId,
                CustomerId: customer.id,
                remoteJid,
                phoneNumber: senderPhone,
                customerName: customer.customerName,
                lastMessage: text,
                lastMessageText: text,
                lastMessageTime: new Date(),
                lastMessageAt: new Date(),
                unreadCount: 1,
                status: 'open'
            });
        }

        // 7. البث اللحظي للـ LiveChat عبر Socket.IO
        if (io) {
            const payload = {
                ...savedMsg.toJSON(),
                phoneNumber: customer.phoneNumber || senderPhone,
                customerName: customer.customerName || senderPhone
            };
            io.to('crm_staff').emit('new_message', payload);
            if (targetUserId) {
                io.to(`user_${targetUserId}`).emit('new_message', payload);
            }
        }

        // 8. وضع علامة مقروء على الرسالة في واتساب
        await markMetaMessageAsRead(messageId, { userId: targetUserId });

        // 9. إرسال إشعار للموظف المسؤول عبر نظام التنبيهات
        try {
            await createNotification({
                type: 'new_message',
                title: `رسالة جديدة من ${customer.customerName}`,
                message: text || 'أرسل وسائط جديدة عبر واتساب ميتا',
                targetUserId,
                customerId: customer.id,
                ownerId: defaultAdminId,
                io
            });
        } catch (notifErr) {
            console.error('Error creating notification:', notifErr);
        }

        // 10. الرد الآلي للعميل عبر واتساب ميتا بيزنس (Auto-Reply)
        const isBotActive = customer.isBotActive !== false && !customer.isManualOverride && !conv.is_handoff;
        if (isBotActive && text && text.trim().length > 0) {
            try {
                const welcomeMsg = await getSetting('welcome_message', targetUserId);
                const modelCount = await Message.count({ where: { UserId: targetUserId, remoteJid, role: 'model' } });

                let botReplyText = null;
                if (modelCount === 0 && welcomeMsg) {
                    botReplyText = welcomeMsg;
                } else {
                    const cleanUserText = text.trim().toLowerCase();
                    if (['1', '2', '3', '4'].includes(cleanUserText)) {
                        const courseDetails = await getSetting('course_details', targetUserId);
                        botReplyText = courseDetails || 'شكراً لاختيارك! تفاصيل ومواعيد الكورس سنرسلها لك في الرسالة التالية.';
                    } else if (cleanUserText.includes('تفاصيل') || cleanUserText.includes('سعر') || cleanUserText.includes('كام')) {
                        const courseDetails = await getSetting('course_details', targetUserId);
                        botReplyText = courseDetails || welcomeMsg;
                    } else {
                        // رد ترحيبي ذكي بالافتراض
                        botReplyText = welcomeMsg || 'أهلاً بك! نسعد بتواصلك معنا، كيف يمكننا مساعدتك اليوم؟ 😊';
                    }
                }

                if (botReplyText) {
                    await sendMetaTextMessage(remoteJid, botReplyText, { userId: targetUserId });
                    const savedBotMsg = await Message.create({
                        UserId: targetUserId,
                        remoteJid,
                        role: 'model',
                        content: botReplyText,
                        status: 'sent'
                    });

                    conv.lastMessage = botReplyText;
                    conv.lastMessageText = botReplyText;
                    conv.lastMessageTime = new Date();
                    conv.lastMessageAt = new Date();
                    await conv.save();

                    if (io) {
                        const botPayload = {
                            ...savedBotMsg.toJSON(),
                            phoneNumber: customer.phoneNumber || senderPhone,
                            customerName: customer.customerName || senderPhone
                        };
                        io.to('crm_staff').emit('new_message', botPayload);
                        if (targetUserId) {
                            io.to(`user_${targetUserId}`).emit('new_message', botPayload);
                        }
                    }
                    console.log(`🤖 [WhatsApp Meta Auto-Reply Sent] To ${senderPhone}: "${botReplyText.substring(0, 30)}..."`);
                }
            } catch (autoReplyErr) {
                console.error('⚠️ [Meta Auto-Reply Error]:', autoReplyErr);
            }
        }

        console.log(`💬 [WhatsApp Meta Message Handled] From: ${customer.customerName} (${senderPhone}): "${text}"`);
    } catch (msgErr) {
        console.error('❌ [WhatsApp Meta Message Processing Error]:', msgErr);
    }
}

export default router;
