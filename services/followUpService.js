import { Op, Sequelize } from 'sequelize';
import Customer from '../models/Customer.js';
import User from '../models/User.js';
import Message from '../models/Message.js';
import ChangeLog from '../models/ChangeLog.js';
import FollowUp from '../models/FollowUp.js';
import { getSetting as getSystemSetting } from './settingsService.js';
import * as notificationService from './notificationService.js';
import { sessions, generateDynamicFollowUpMessage, sendHumanMessage } from '../controllers/botController.js';

// 🔒 أقفال لمنع تداخل وتشغيل الدورات بشكل متزامن داخل نفس العملية
let isCheckingPendingFollowUps = false;
let isCheckingScheduledFollowUps = false;

export const checkPendingFollowUps = async (io) => {
    if (isCheckingPendingFollowUps) {
        console.log('⏳ [FollowUpService] checkPendingFollowUps already in progress. Skipping duplicate tick.');
        return;
    }
    isCheckingPendingFollowUps = true;

    try {
        const now = new Date();
        const activeUsers = await User.findAll({ where: { auto_reply: true } });
        
        for (const user of activeUsers) {
            const userId = user.id;
            const sock = sessions.get(userId);
            if (!sock) continue;

            // 1. تحويل البوت التلقائي للعملاء الصامتين إلى حالة "first_follow_up" وجدولة المتابعة الأولى لهم
            const noActionTimeout = await getSystemSetting('no_action_timeout', userId) || 10;
            const noActionCutoff = new Date(now.getTime() - (noActionTimeout * 60 * 1000));

            const silentCustomers = await Customer.findAll({
                where: {
                    UserId: userId,
                    status: { [Op.in]: ['new', 'in_funnel'] },
                    lastBotMessageAt: {
                        [Op.ne]: null,
                        [Op.lte]: noActionCutoff
                    },
                    [Op.or]: [
                        { lastReplyAt: null },
                        { lastReplyAt: { [Op.lt]: Sequelize.col('lastBotMessageAt') } }
                    ]
                }
            });

            for (const customer of silentCustomers) {
                try {
                    // حماية: إذا كان العميل قد أُرسلت له متابعة سابقة ولم يقم بالرد بعدها إطلاقاً، فلا نعيد جدولته مجدداً
                    const lastSentFollowUp = await FollowUp.findOne({
                        where: { CustomerId: customer.id, status: 'sent' },
                        order: [['sentAt', 'DESC']]
                    });
                    if (lastSentFollowUp) {
                        if (!customer.lastReplyAt || customer.lastReplyAt <= lastSentFollowUp.sentAt) {
                            continue; // العميل لم يرد بعد آخر متابعة، نتركه ولا نعيد إدخاله في دورة متابعة جديدة
                        }
                    }

                    const oldStatus = customer.status;
                    customer.status = 'first_follow_up';
                    
                    // جدولة المتابعة الأولى بعد first_followup_delay
                    const firstFollowupDelay = await getSystemSetting('first_followup_delay', userId);
                    const firstFollowupDelayUnit = await getSystemSetting('first_followup_delay_unit', userId) || 'hours';
                    const firstFollowupDelayMs = firstFollowupDelayUnit === 'hours'
                        ? firstFollowupDelay * 60 * 60 * 1000
                        : firstFollowupDelay * 60 * 1000;
                    
                    customer.scheduledFollowUpAt = new Date(now.getTime() + firstFollowupDelayMs);
                    await customer.save();

                    await ChangeLog.create({
                        action: 'status_change',
                        description: `توقف العميل عن الرد. قام البوت بتحويل الحالة تلقائياً إلى "متابعة أولى" وجدولة رسالة المتابعة الأولى بعد مرور الوقت المحدد.`,
                        oldValue: oldStatus,
                        newValue: 'first_follow_up',
                        CustomerId: customer.id,
                        performedByUserId: userId,
                        UserId: userId
                    });

                    console.log(`[FollowUpService] Auto-moved silent customer ${customer.phoneNumber} to first_follow_up and scheduled first follow-up.`);
                } catch (err) {
                    console.error(`Error auto-moving silent customer ${customer.id} to first_follow_up:`, err);
                }
            }

            // 🛡️ حماية ضد الحظر: منع إرسال رسائل المتابعة التلقائية في ساعات النوم (من 11 مساءً حتى 9 صباحاً بتوقيت القاهرة)
            const cairoHourStr = new Intl.DateTimeFormat('en-US', {
                timeZone: 'Africa/Cairo',
                hour: 'numeric',
                hour12: false
            }).format(now);
            const cairoHour = parseInt(cairoHourStr, 10);
            const isQuietHours = (cairoHour >= 23 || cairoHour < 9);

            if (isQuietHours) {
                console.log(`🌙 [FollowUp Anti-Ban] وقت الهدوء الليلي (${cairoHour}:00 بتوقيت القاهرة). تأجيل إرسال رسائل المتابعة للصباح لمنع الإزعاج والحظر.`);
            }

            // 2. معالجة المتابعات المجدولة للعملاء في حالة "first_follow_up" أو "final_follow_up"
            const scheduledCustomers = isQuietHours ? [] : await Customer.findAll({
                where: {
                    UserId: userId,
                    status: {
                        [Op.in]: ['first_follow_up', 'final_follow_up']
                    },
                    scheduledFollowUpAt: {
                        [Op.ne]: null,
                        [Op.lte]: now
                    },
                    [Op.or]: [
                        { lastReplyAt: null },
                        { lastReplyAt: { [Op.lt]: Sequelize.col('lastBotMessageAt') } }
                    ]
                },
                limit: 3
            });

            // 🔒 حجز فوري في قاعدة البيانات: تصفير scheduledFollowUpAt لحظياً لمنع التقاط نفس العملاء من أي دورة متوازية أخرى
            if (scheduledCustomers.length > 0) {
                const pickedIds = scheduledCustomers.map(c => c.id);
                await Customer.update(
                    { scheduledFollowUpAt: null },
                    { where: { id: { [Op.in]: pickedIds } } }
                );
            }

            for (let idx = 0; idx < scheduledCustomers.length; idx++) {
                const customer = scheduledCustomers[idx];
                // فاصل أمان إضافي بين كل رسالة متابعة والأخرى (20 إلى 35 ثانية) لأنها رسائل إعادة تواصل
                if (idx > 0) {
                    const followUpWait = Math.floor(Math.random() * (35000 - 20000) + 20000);
                    console.log(`⏳ [FollowUp Anti-Ban] انتظار ${(followUpWait / 1000).toFixed(0)} ثانية قبل إرسال رسالة المتابعة التالية...`);
                    await new Promise(r => setTimeout(r, followUpWait));
                }

                try {
                    // التحقق هل تم إرسال المتابعة الأولى أو النهائية للعميل من قبل
                    const firstFollowupSent = await FollowUp.findOne({
                        where: {
                            CustomerId: customer.id,
                            type: 'first',
                            status: 'sent'
                        }
                    });
                    const finalFollowupSent = await FollowUp.findOne({
                        where: {
                            CustomerId: customer.id,
                            type: 'final',
                            status: 'sent'
                        }
                    });

                    if (customer.status === 'first_follow_up') {
                        if (firstFollowupSent) {
                            console.log(`[FollowUpService] ⚠️ First follow-up already sent for ${customer.phoneNumber}. Skipping first follow-up.`);
                            // إذا لم تكن المتابعة النهائية قد أُرسلت بعد، نقوم بجدولتها
                            if (!finalFollowupSent) {
                                const finalFollowupDelay = await getSystemSetting('final_followup_delay', userId);
                                const finalFollowupDelayUnit = await getSystemSetting('final_followup_delay_unit', userId) || 'hours';
                                const finalFollowupDelayMs = finalFollowupDelayUnit === 'hours'
                                    ? finalFollowupDelay * 60 * 60 * 1000
                                    : finalFollowupDelay * 60 * 1000;

                                customer.status = 'final_follow_up';
                                customer.scheduledFollowUpAt = new Date(now.getTime() + finalFollowupDelayMs);
                                await customer.save();
                            } else {
                                customer.status = 'final_follow_up';
                                customer.scheduledFollowUpAt = null;
                                await customer.save();
                            }
                            continue;
                        }

                        // --- إرسال المتابعة الأولى ---
                        const firstFollowupMessage = await getSystemSetting('first_followup_message', userId);
                        const firstFollowupType = await getSystemSetting('first_followup_type', userId) || 'static';

                        let customerFirstMsg = firstFollowupMessage;
                        if (firstFollowupType === 'dynamic') {
                            customerFirstMsg = await generateDynamicFollowUpMessage(customer.id, userId, firstFollowupMessage);
                        }

                        await sendHumanMessage(sock, customer.remoteJid, { text: customerFirstMsg }, { userId });

                        await Message.create({
                            UserId: userId,
                            remoteJid: customer.remoteJid,
                            role: 'model',
                            content: customerFirstMsg,
                            status: 'sent'
                        });

                        // تسجيل المتابعة الأولى في السجل
                        await FollowUp.create({
                            CustomerId: customer.id,
                            UserId: userId,
                            type: 'first',
                            status: 'sent',
                            message: customerFirstMsg,
                            scheduledAt: now,
                            sentAt: new Date()
                        });

                        // جدولة المتابعة النهائية تلقائياً
                        const finalFollowupDelay = await getSystemSetting('final_followup_delay', userId);
                        const finalFollowupDelayUnit = await getSystemSetting('final_followup_delay_unit', userId) || 'hours';
                        const finalFollowupDelayMs = finalFollowupDelayUnit === 'hours'
                            ? finalFollowupDelay * 60 * 60 * 1000
                            : finalFollowupDelay * 60 * 1000;

                        customer.status = 'final_follow_up';
                        customer.scheduledFollowUpAt = new Date(now.getTime() + finalFollowupDelayMs);
                        customer.lastBotMessageAt = new Date();
                        await customer.save();

                        await ChangeLog.create({
                            action: 'follow_up',
                            description: `حان موعد المتابعة الأولى. تم إرسال رسالة المتابعة الأولى وجدولة المتابعة النهائية.`,
                            CustomerId: customer.id,
                            performedByUserId: userId,
                            UserId: userId
                        });

                        await notificationService.createNotification({
                            type: 'status_changed',
                            title: 'إرسال المتابعة الأولى',
                            message: `تم إرسال المتابعة الأولى للعميل: ${customer.customerName || customer.phoneNumber}`,
                            targetUserId: customer.assignedToUserId || userId,
                            customerId: customer.id,
                            ownerId: userId,
                            io
                        });

                        console.log(`[FollowUpService] Sent scheduled first follow-up to ${customer.phoneNumber}`);

                    } else if (customer.status === 'final_follow_up') {
                        if (finalFollowupSent) {
                            console.log(`[FollowUpService] ⚠️ Final follow-up already sent for ${customer.phoneNumber}. Skipping duplicate.`);
                            customer.scheduledFollowUpAt = null;
                            await customer.save();
                            continue;
                        }

                        // --- إرسال المتابعة النهائية ---
                        const finalFollowupMessage = await getSystemSetting('final_followup_message', userId);
                        const finalFollowupType = await getSystemSetting('final_followup_type', userId) || 'static';

                        let customerFinalMsg = finalFollowupMessage;
                        if (finalFollowupType === 'dynamic') {
                            customerFinalMsg = await generateDynamicFollowUpMessage(customer.id, userId, finalFollowupMessage);
                        }

                        await sendHumanMessage(sock, customer.remoteJid, { text: customerFinalMsg }, { userId });

                        await Message.create({
                            UserId: userId,
                            remoteJid: customer.remoteJid,
                            role: 'model',
                            content: customerFinalMsg,
                            status: 'sent'
                        });

                        // تسجيل المتابعة النهائية في السجل
                        await FollowUp.create({
                            CustomerId: customer.id,
                            UserId: userId,
                            type: 'final',
                            status: 'sent',
                            message: customerFinalMsg,
                            scheduledAt: now,
                            sentAt: new Date()
                        });

                        customer.status = 'final_follow_up';
                        customer.lastBotMessageAt = new Date();
                        customer.scheduledFollowUpAt = null; // تفريغ الحقل نهائياً حتى لا يتم تكرار الإرسال
                        await customer.save();

                        await ChangeLog.create({
                            action: 'status_change',
                            description: `حان موعد المتابعة النهائية. تم إرسال رسالة العرض والمتابعة النهائية.`,
                            oldValue: 'first_follow_up',
                            newValue: 'final_follow_up',
                            CustomerId: customer.id,
                            performedByUserId: userId,
                            UserId: userId
                        });

                        await notificationService.createNotification({
                            type: 'status_changed',
                            title: 'إرسال المتابعة النهائية',
                            message: `تم إرسال المتابعة النهائية للعميل: ${customer.customerName || customer.phoneNumber}`,
                            targetUserId: customer.assignedToUserId || userId,
                            customerId: customer.id,
                            ownerId: userId,
                            io
                        });

                        console.log(`[FollowUpService] Sent scheduled final follow-up to ${customer.phoneNumber}`);
                    } else {
                        // العميل ليس في حالة متابعة أولى أو نهائية (تم تغيير حالته مثلاً)
                        customer.scheduledFollowUpAt = null;
                        await customer.save();
                    }
                } catch (err) {
                    console.error(`Error processing scheduled follow-up for customer ${customer.id}:`, err);
                }
            }

            // 3. انتهاء المهلة (Expired/Not Interested)
            const expireCutoff = new Date(now.getTime() - (48 * 60 * 60 * 1000));
            const expiredCustomers = await Customer.findAll({
                where: {
                    UserId: userId,
                    status: 'final_follow_up',
                    lastBotMessageAt: {
                        [Op.ne]: null,
                        [Op.lte]: expireCutoff
                    },
                    [Op.or]: [
                        { lastReplyAt: null },
                        { lastReplyAt: { [Op.lt]: Sequelize.col('lastBotMessageAt') } }
                    ]
                }
            });

            for (const customer of expiredCustomers) {
                try {
                    const oldStatus = customer.status;
                    customer.status = 'not_interested';
                    customer.scheduledFollowUpAt = null;
                    await customer.save();

                    // التحقق من عدم تسجيل انتهاء المهلة مسبقاً
                    const existingExpired = await FollowUp.findOne({
                        where: { CustomerId: customer.id, type: 'no_action', status: 'expired' }
                    });

                    if (!existingExpired) {
                        await FollowUp.create({
                            CustomerId: customer.id,
                            UserId: userId,
                            type: 'no_action',
                            status: 'expired',
                            message: 'لم يتم الرد بعد المتابعة النهائية بـ 48 ساعة.',
                            scheduledAt: expireCutoff,
                            sentAt: new Date()
                        });
                    }

                    await ChangeLog.create({
                        action: 'status_change',
                        description: `تم إغلاق العميل تلقائياً وتغيير الحالة إلى "غير مهتم" لعدم الرد بعد المتابعة النهائية بـ 48 ساعة.`,
                        oldValue: oldStatus,
                        newValue: 'not_interested',
                        CustomerId: customer.id,
                        performedByUserId: userId,
                        UserId: userId
                    });

                    await notificationService.createNotification({
                        type: 'status_changed',
                        title: 'عميل غير مهتم تلقائي',
                        message: `تم تحويل العميل تلقائياً إلى غير مهتم لعدم الاستجابة: ${customer.customerName || customer.phoneNumber}`,
                        targetUserId: customer.assignedToUserId || userId,
                        customerId: customer.id,
                        ownerId: userId,
                        io
                    });

                    console.log(`[FollowUpService] Customer ${customer.phoneNumber} marked as not_interested automatically.`);
                } catch (err) {
                    console.error(`Error expiring customer ${customer.id}:`, err);
                }
            }
        }
    } catch (error) {
        console.error('Error in checkPendingFollowUps background job:', error);
    } finally {
        isCheckingPendingFollowUps = false;
    }
};

/**
 * دالة لفحص المتابعات المجدولة يدوياً بواسطة موظف المبيعات
 */
export const checkScheduledFollowUps = async (io) => {
    if (isCheckingScheduledFollowUps) {
        console.log('⏳ [FollowUpService] checkScheduledFollowUps already running. Skipping.');
        return;
    }
    isCheckingScheduledFollowUps = true;

    try {
        const now = new Date();
        const pendingFollowUps = await FollowUp.findAll({
            where: {
                type: 'scheduled',
                status: 'pending',
                scheduledAt: { [Op.lte]: now }
            },
            include: [{ model: Customer, as: 'customer' }]
        });

        // 🔒 حجز فوري في قاعدة البيانات لتفادي تكرار إرسال نفس المتابعة
        if (pendingFollowUps.length > 0) {
            const pIds = pendingFollowUps.map(f => f.id);
            await FollowUp.update(
                { status: 'sent', sentAt: now },
                { where: { id: { [Op.in]: pIds } } }
            );
        }

        for (const followup of pendingFollowUps) {
            const userId = followup.UserId;
            const sock = sessions.get(userId);
            if (!sock || !followup.customer) continue;

            try {
                // إرسال رسالة المتابعة المجدولة
                if (followup.message) {
                    await sendHumanMessage(sock, followup.customer.remoteJid, { text: followup.message }, { userId });
                    
                    await Message.create({
                        UserId: userId,
                        remoteJid: followup.customer.remoteJid,
                        role: 'model',
                        content: followup.message,
                        status: 'sent'
                    });
                }

                await ChangeLog.create({
                    action: 'follow_up',
                    description: `تم إرسال رسالة المتابعة المجدولة يدوياً للعميل.`,
                    CustomerId: followup.customer.id,
                    performedByUserId: userId,
                    UserId: userId
                });

                await notificationService.createNotification({
                    type: 'follow_up_sent',
                    title: 'متابعة مجدولة',
                    message: `تم إرسال رسالة المتابعة المجدولة للعميل: ${followup.customer.customerName || followup.customer.phoneNumber}`,
                    targetUserId: followup.customer.assignedToUserId || userId,
                    customerId: followup.customer.id,
                    ownerId: userId,
                    io
                });

                console.log(`[FollowUpService] Sent scheduled follow-up for customer ${followup.customer.phoneNumber}`);
            } catch (err) {
                console.error(`Error sending scheduled follow-up ID ${followup.id}:`, err);
            }
        }

        // 2. فحص العملاء الذين تم تحديد موعد متابعة مجدول لهم عبر واجهة كروت العملاء (status: 'scheduled_follow_up')
        const dueCustomers = await Customer.findAll({
            where: {
                status: 'scheduled_follow_up',
                scheduledFollowUpAt: {
                    [Op.ne]: null,
                    [Op.lte]: now
                }
            }
        });

        if (dueCustomers.length > 0) {
            const dueIds = dueCustomers.map(c => c.id);
            // 🔒 حجز فوري بتصفير scheduledFollowUpAt لمنع التكرار
            await Customer.update(
                { scheduledFollowUpAt: null },
                { where: { id: { [Op.in]: dueIds } } }
            );
        }

        for (const customer of dueCustomers) {
            try {
                const ownerId = customer.UserId;
                const assignedUserId = customer.assignedToUserId;
                const customerPhone = customer.remoteJid;

                const oldStatus = customer.status;
                customer.status = 'final_follow_up';
                customer.scheduledFollowUpAt = null;
                await customer.save();

                await ChangeLog.create({
                    action: 'status_change',
                    description: `موعد المتابعة حان. تم إرسال تذكير تلقائي وتغيير الحالة إلى "متابعة نهائية"`,
                    oldValue: oldStatus,
                    newValue: 'final_follow_up',
                    CustomerId: customer.id,
                    performedByUserId: ownerId,
                    UserId: ownerId
                });

                const sock = sessions.get(ownerId);
                if (sock && customerPhone) {
                    const messageText = `أهلاً بك ${customer.customerName || ''}، بناءً على طلبك نذكرك بموعد المتابعة. هل أنت متاح الآن للحديث؟`;
                    await sendHumanMessage(sock, customerPhone, { text: messageText }, { userId: ownerId });
                }

                const targetUserId = assignedUserId || ownerId;
                if (targetUserId) {
                    await notificationService.createNotification({
                        type: 'follow_up_due',
                        title: 'متابعة مستحقة',
                        message: `حان موعد متابعة العميل: ${customer.customerName || customer.phoneNumber}`,
                        targetUserId: targetUserId,
                        customerId: customer.id,
                        ownerId: ownerId,
                        io: io
                    });
                }

                console.log(`[FollowUpService] Processed scheduled_follow_up for customer ${customer.id}`);
            } catch (innerErr) {
                console.error(`[FollowUpService] Error processing scheduled customer ${customer.id}:`, innerErr);
            }
        }
    } catch (error) {
        console.error('Error in checkScheduledFollowUps:', error);
    } finally {
        isCheckingScheduledFollowUps = false;
    }
};
