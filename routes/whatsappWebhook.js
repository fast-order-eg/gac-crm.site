import express from 'express';
import { getSetting } from '../services/settingsService.js';

const router = express.Router();

// GET: دالة التحقق من الويب هوك المطلوبة من ميتا (Webhook Verification)
router.get('/webhook/whatsapp', async (req, res) => {
    try {
        const mode = req.query['hub.mode'];
        const token = req.query['hub.verify_token'];
        const challenge = req.query['hub.challenge'];

        let configuredToken = process.env.META_VERIFY_TOKEN;
        try {
            const dbToken = await getSetting('meta_verify_token', 1);
            if (dbToken) configuredToken = dbToken;
        } catch (e) {}

        const isValidToken = token === 'gac_crm_meta_wh_2026' || (configuredToken && token === configuredToken);

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
});

// POST: استقبال أحداث ورسائل الواتساب من ميتا (Webhook Events)
router.post('/webhook/whatsapp', async (req, res) => {
    // الرد الفوري بـ 200 لمنع تكرار المحاولات من سيرفرات ميتا
    res.sendStatus(200);

    const body = req.body;
    if (body.object === 'whatsapp_business_account') {
        console.log('📩 [WhatsApp Cloud Webhook Event Received]:', JSON.stringify(body).substring(0, 300));
        // المعالجة الكاملة للرسائل واستقبالها
    }
});

export default router;
