import express from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { startSession, stopSession, logoutSession, getStatus, getGroups, sendManualMessage, sendManualMediaMessage, generateCustomerSummary, checkGacCrmGroup, sendReaction } from '../controllers/botController.js';
import User from '../models/User.js';
import Message from '../models/Message.js';
import Customer from '../models/Customer.js';
import Conversation from '../models/Conversation.js';
import FollowUp from '../models/FollowUp.js';
import ChangeLog from '../models/ChangeLog.js';
import MessengerConversation from '../models/MessengerConversation.js';
import MessengerPage from '../models/MessengerPage.js';
import Campaign from '../models/Campaign.js';
import Instruction from '../models/Instruction.js';
import Product from '../models/Product.js';
import InteractiveButton from '../models/InteractiveButton.js';
import InteractiveMenu from '../models/InteractiveMenu.js';
import SystemSettings from '../models/SystemSettings.js';
import { upload, compressAndSaveImage, deleteImage } from '../config/uploadConfig.js';
import { Op, Sequelize } from 'sequelize';
import { ensureAuthenticated, isAdmin, isSuperAdmin, isSales, canAccessSettings } from '../middleware/permissions.js';
import { logChange } from '../services/changeLogService.js';
import { createNotification, markAsRead, markAllAsRead, getUnreadCount, getNotifications } from '../services/notificationService.js';
import Notification from '../models/Notification.js';
import { getSetting, setSetting, defaultSettingsMeta } from '../services/settingsService.js';
import FinancialTransaction from '../models/FinancialTransaction.js';

const router = express.Router();

// Use permissions middleware to ensure login
router.use(ensureAuthenticated);

// Role-based path checks to protect dashboard features
router.use((req, res, next) => {
    const path = req.path;
    const role = req.user.role;

    // List of admin-only paths
    const adminPaths = [
        '/start-bot', '/pair-bot', '/stop-bot', '/logout-bot', '/groups',
        '/instructions', '/gallery', '/products', '/training', '/analytics',
        '/employees', '/changelog', '/kpi', '/finance'
    ];

    const isSettingsPath = path.startsWith('/settings');
    const isAdminPath = adminPaths.some(p => path === p || path.startsWith(p + '/'));

    if (isAdminPath) {
        if (role === 'super_admin' || role === 'admin') {
            return next();
        }
        req.flash('error_msg', 'غير مسموح لك بالوصول. صلاحية الأدمن مطلوبة.');
        return res.redirect('/dashboard');
    }

    if (isSettingsPath) {
        if (role === 'super_admin' || role === 'admin') {
            return next();
        }
        req.flash('error_msg', 'غير مسموح لك بالوصول للإعدادات.');
        return res.redirect('/dashboard');
    }

    next();
});

router.get('/', async (req, res) => {
    if (req.user.role === 'super_admin') {
        return res.redirect('/admin');
    }

    try {
        let ownerId = req.user.id;
        if (req.user.role === 'sales') {
            // Find the first admin user in the system to check their bot status
            const adminUser = await User.findOne({ where: { role: 'admin' } });
            if (adminUser) {
                ownerId = adminUser.id;
            }
        }
        const statusResult = await getStatus(ownerId);

        // 1. Where clause based on role
        const whereClause = {};
        if (req.user.role === 'sales') {
            whereClause.assignedToUserId = req.user.id;
        } else {
            whereClause.UserId = req.user.id;
        }

        // Detailed employees stats (Admin only) - computed first to sum awaitingSalesCount
        const employeesStats = [];
        if (req.user.role !== 'sales') {
            const employees = await User.findAll({
                where: {
                    role: 'sales'
                },
                order: [['fullName', 'ASC']]
            });
            for (const emp of employees) {
                const count = await Customer.count({
                    where: {
                        UserId: req.user.id,
                        assignedToUserId: emp.id,
                        status: {
                            [Op.notIn]: ['successful', 'not_interested']
                        }
                    }
                });
                employeesStats.push({
                    id: emp.id,
                    fullName: emp.fullName || emp.username,
                    count
                });
            }
        }

        // 2. Query customer counts for each status
        const successfulCount = await Customer.count({
            where: { ...whereClause, status: 'successful' }
        });
        const notInterestedCount = await Customer.count({
            where: { ...whereClause, status: 'not_interested' }
        });

        // "مع المبيعات" represents the sum of all clients in follow-up across sales team (or assigned to this sales user)
        let awaitingSalesCount = 0;
        if (req.user.role !== 'sales') {
            awaitingSalesCount = employeesStats.reduce((sum, emp) => sum + emp.count, 0);
        } else {
            awaitingSalesCount = await Customer.count({
                where: {
                    assignedToUserId: req.user.id,
                    status: {
                        [Op.notIn]: ['successful', 'not_interested']
                    }
                }
            });
        }

        const firstFollowUpCount = await Customer.count({
            where: { ...whereClause, status: 'first_follow_up' }
        });
        const finalFollowUpCount = await Customer.count({
            where: { ...whereClause, status: 'final_follow_up' }
        });
        const scheduledFollowUpCount = await Customer.count({
            where: { ...whereClause, status: 'scheduled_follow_up' }
        });

        // Total customers for this context (sales vs owner)
        const totalCount = await Customer.count({ where: whereClause });

        // 3. Calculate conversion rate: (successful / total) * 100
        const conversionRate = totalCount > 0 ? ((successfulCount / totalCount) * 100).toFixed(1) : '0';

        // 4. Last 7 days new customers chart data
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
        sevenDaysAgo.setHours(0, 0, 0, 0);

        const customersLast7Days = await Customer.findAll({
            attributes: [
                [Sequelize.fn('date', Sequelize.col('firstContactAt')), 'date'],
                [Sequelize.fn('count', Sequelize.col('id')), 'count']
            ],
            where: {
                ...whereClause,
                firstContactAt: {
                    [Op.gte]: sevenDaysAgo
                }
            },
            group: [Sequelize.fn('date', Sequelize.col('firstContactAt'))],
            order: [[Sequelize.fn('date', Sequelize.col('firstContactAt')), 'ASC']]
        });

        const chartLabels = [];
        const chartData = [];
        const daysOfWeek = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const dateStr = d.toISOString().split('T')[0];
            
            // Format label as "Mon 18" or similar
            const label = daysOfWeek[d.getDay()] + ' ' + d.getDate();
            chartLabels.push(label);

            const found = customersLast7Days.find(item => item.get('date') === dateStr);
            chartData.push(found ? parseInt(found.get('count')) : 0);
        }

        // 5. Last 5 customers
        const last5Customers = await Customer.findAll({
            where: whereClause,
            order: [['firstContactAt', 'DESC']],
            limit: 5,
            include: [
                {
                    model: User,
                    as: 'assignedTo',
                    attributes: ['fullName', 'username']
                }
            ]
        });

        res.render('user_dashboard', {
            user: req.user,
            status: statusResult.status || 'offline',
            phone: statusResult.phone || '',
            page: 'home',
            stats: {
                successfulCount,
                notInterestedCount,
                awaitingSalesCount,
                firstFollowUpCount,
                finalFollowUpCount,
                scheduledFollowUpCount,
                totalCount
            },
            conversionRate,
            chartLabels,
            chartData,
            last5Customers,
            employeesStats
        });

    } catch (err) {
        console.error('Error fetching dashboard stats:', err);
        res.status(500).send('حدث خطأ أثناء تحميل بيانات لوحة التحكم.');
    }
});



router.post('/start-bot', async (req, res) => {
    const io = req.app.get('socketio');
    const result = await startSession(req.user.id, io);
    res.json(result);
});

router.post('/pair-bot', async (req, res) => {
    const { phoneNumber } = req.body;
    const io = req.app.get('socketio');
    const result = await startSession(req.user.id, io, phoneNumber);
    res.json(result);
});

router.post('/stop-bot', async (req, res) => {
    const io = req.app.get('socketio');
    const result = await stopSession(req.user.id, io);
    res.json(result);
});

router.post('/logout-bot', async (req, res) => {
    const io = req.app.get('socketio');
    const result = await logoutSession(req.user.id, io);
    res.json(result);
});

router.get('/groups', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const groups = await getGroups(req.user.id, page);
        res.json(groups);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch groups' });
    }
});

// Instructions CRUD
router.get('/instructions', async (req, res) => {
    try {
        const instructions = await Instruction.findAll({
            where: { 
                UserId: req.user.id,
                type: { [Op.ne]: 'gallery' }
            },
            order: [['order', 'ASC'], ['createdAt', 'DESC']]
        });

        // Groups fetch removed to prevent hanging. Groups can be loaded via AJAX if needed.
        const groups = [];
        res.render('instructions', { user: req.user, page: 'instructions', instructions, groups, success: false });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error fetching instructions");
    }
});

import { analyzeAndSegmentText, generateKeywords } from '../controllers/aiController.js';
import SimulationMessage from '../models/SimulationMessage.js';
import TeachMessage from '../models/TeachMessage.js';
import { simulateChat, teachBot } from '../controllers/botController.js';

router.post('/instructions/add', async (req, res) => {
    try {
        const { clientName, title, content, actionTarget, imageUrl } = req.body;

        console.log("📝 Received instruction data:", { clientName, title, content: content?.substring(0, 50) });

        let keywords = '';
        try {
            console.log("🧠 Generating keywords for instruction...");
            const kwResult = await generateKeywords(content);
            if (kwResult) keywords = kwResult;
        } catch (aiError) {
            console.log("⚠️ Keyword generation failed, saving without AI keywords:", aiError.message);
        }

        await Instruction.create({
            clientName,
            title,
            content,
            actionTarget,
            imageUrl: imageUrl || '',
            UserId: req.user.id,
            keywords: keywords,
            type: 'topic'
        });

        res.redirect('/dashboard/instructions');
    } catch (err) {
        console.error(err);
        res.status(500).send("Error adding instruction");
    }
});

// Gallery CRUD
router.get('/gallery', async (req, res) => {
    try {
        const instructions = await Instruction.findAll({
            where: { UserId: req.user.id, type: 'gallery' },
            order: [['order', 'ASC'], ['createdAt', 'DESC']]
        });
        const groups = [];
        res.render('gallery', { user: req.user, page: 'gallery', instructions, groups, success: false });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error fetching gallery");
    }
});

router.post('/gallery/add', async (req, res) => {
    try {
        const { clientName, imageUrl } = req.body;

        // AI generates description and keywords automatically
        let autoContent = `منتج/خدمة: ${clientName}`;
        let autoKeywords = clientName;

        try {
            const { generateKeywords } = await import('../controllers/aiController.js');
            const kwResult = await generateKeywords(clientName);
            if (kwResult) autoKeywords = kwResult;
            autoContent = `هذا المنتج/الخدمة: ${clientName}.`;
        } catch (aiErr) {
            console.log('⚠️ AI keyword gen failed, using defaults:', aiErr.message);
        }

        await Instruction.create({
            clientName,
            title: clientName,
            content: autoContent,
            actionTarget: '',
            imageUrl: imageUrl || '',
            UserId: req.user.id,
            keywords: autoKeywords,
            type: 'gallery'
        });

        res.redirect('/dashboard/gallery');
    } catch (err) {
        console.error(err);
        res.status(500).send("Error adding to gallery");
    }
});

router.post('/gallery/edit', async (req, res) => {
    try {
        const { id, clientName, imageUrl } = req.body;

        await Instruction.update({
            clientName,
            title: clientName,
            imageUrl: imageUrl || ''
        }, { where: { id: id, UserId: req.user.id } });

        res.redirect('/dashboard/gallery');
    } catch (err) {
        console.error(err);
        res.status(500).send("Error updating gallery");
    }
});

// Delete gallery item
router.post('/gallery/delete', async (req, res) => {
    try {
        await Instruction.destroy({ where: { id: req.body.id, UserId: req.user.id, type: 'gallery' } });
        res.redirect('/dashboard/gallery');
    } catch (err) {
        console.error(err);
        res.status(500).send("Error deleting gallery item");
    }
});


// ============================================================
// 🛍️ Products & Services CRUD
// ============================================================
router.get('/products', async (req, res) => {
    try {
        const typeFilter = req.query.type; // 'product', 'service', or undefined (all)
        const where = { UserId: req.user.id };
        if (typeFilter && ['product', 'service'].includes(typeFilter)) {
            where.type = typeFilter;
        }

        const products = await Product.findAll({
            where,
            order: [['createdAt', 'DESC']]
        });

        res.render('products', {
            user: req.user,
            page: 'products',
            products,
            activeFilter: typeFilter || 'all',
            success: req.query.success === '1'
        });
    } catch (err) {
        console.error('Products page error:', err);
        res.status(500).send("Error fetching products");
    }
});

router.post('/products/add', async (req, res) => {
    try {
        const { name, type, description, price, currency, category, imageUrl } = req.body;

        // Validate type
        const validType = ['product', 'service'].includes(type) ? type : 'product';

        // AI generates keywords automatically
        let autoKeywords = name;
        try {
            const { generateKeywords } = await import('../controllers/aiController.js');
            const kwResult = await generateKeywords(`${name} ${description || ''} ${category || ''}`);
            if (kwResult) autoKeywords = kwResult;
        } catch (aiErr) {
            console.log('⚠️ AI keyword gen failed for product, using name:', aiErr.message);
        }

        await Product.create({
            name,
            type: validType,
            description: description || null,
            price: price ? parseFloat(price) : null,
            currency: currency || 'EGP',
            category: category || null,
            images: imageUrl || '[]',
            keywords: autoKeywords,
            UserId: req.user.id
        });

        res.redirect('/dashboard/products?success=1');
    } catch (err) {
        console.error('Add product error:', err);
        res.status(500).send("Error adding product");
    }
});

router.post('/products/edit', async (req, res) => {
    try {
        const { id, name, type, description, price, currency, category, imageUrl, status } = req.body;

        const validType = ['product', 'service'].includes(type) ? type : 'product';
        const validStatus = ['available', 'out_of_stock'].includes(status) ? status : 'available';

        await Product.update({
            name,
            type: validType,
            description: description || null,
            price: price ? parseFloat(price) : null,
            currency: currency || 'EGP',
            category: category || null,
            images: imageUrl || '[]',
            status: validStatus
        }, { where: { id, UserId: req.user.id } });

        res.redirect('/dashboard/products?success=1');
    } catch (err) {
        console.error('Edit product error:', err);
        res.status(500).send("Error updating product");
    }
});

router.post('/products/delete', async (req, res) => {
    try {
        const product = await Product.findOne({ where: { id: req.body.id, UserId: req.user.id } });
        if (product) {
            // Delete associated images from disk
            const images = product.images || [];
            for (const img of images) {
                if (img.url) {
                    deleteImage(img.url);
                }
            }
            await product.destroy();
        }
        res.redirect('/dashboard/products');
    } catch (err) {
        console.error('Delete product error:', err);
        res.status(500).send("Error deleting product");
    }
});

router.post('/products/toggle/:id', async (req, res) => {
    try {
        const product = await Product.findOne({ where: { id: req.params.id, UserId: req.user.id } });
        if (product) {
            product.isActive = !product.isActive;
            await product.save();
        }
        res.redirect('/dashboard/products');
    } catch (err) {
        console.error('Toggle product error:', err);
        res.status(500).send("Error toggling product");
    }
});


router.post('/instructions/edit/:id', async (req, res) => {
    try {
        const { clientName, title, content, actionTarget, imageUrl, keywords } = req.body;

        let finalKeywords = keywords || '';
        // If content changed or we want to force generate keywords
        if (content) {
            try {
                console.log("🧠 Re-generating keywords for edited instruction...");
                const kwResult = await generateKeywords(content);
                if (kwResult) finalKeywords = kwResult;
            } catch (aiError) {
                console.log("⚠️ Keyword generation failed during edit:", aiError.message);
            }
        }

        await Instruction.update({
            clientName, title, content, actionTarget, imageUrl,
            keywords: finalKeywords
        }, { where: { id: req.params.id } });

        res.redirect('/dashboard/instructions');
    } catch (err) {
        console.error(err);
        res.status(500).send("Error updating instruction");
    }
});

// Alternative route for edit (accepts ID from body instead of URL)
router.post('/instructions/edit', async (req, res) => {
    try {
        const { id, clientName, title, content, actionTarget, imageUrl, keywords } = req.body;

        let finalKeywords = keywords || '';
        // Re-generate keywords
        if (content) {
            try {
                console.log("🧠 Re-generating keywords for edited instruction...");
                const kwResult = await generateKeywords(content);
                if (kwResult) finalKeywords = kwResult;
            } catch (aiError) {
                console.log("⚠️ Keyword generation failed during edit:", aiError.message);
            }
        }

        await Instruction.update({
            clientName, title, content, actionTarget, imageUrl,
            keywords: finalKeywords
        }, { where: { id: id } });

        res.redirect('/dashboard/instructions');
    } catch (err) {
        console.error(err);
        res.status(500).send("Error updating instruction");
    }
});


// [RESTORED] Missing Routes
router.post('/instructions/toggle/:id', async (req, res) => {
    try {
        const instruction = await Instruction.findOne({ where: { id: req.params.id } });
        if (instruction) {
            instruction.isActive = !instruction.isActive;
            await instruction.save();
        }
        res.redirect('/dashboard/instructions');
    } catch (err) { res.status(500).send("Error"); }
});

router.post('/instructions/delete', async (req, res) => {
    try {
        await Instruction.destroy({ where: { id: req.body.id } });
        res.redirect('/dashboard/instructions');
    } catch (err) { res.status(500).send("Error"); }
});

router.post('/instructions/delete-multiple', async (req, res) => {
    try {
        const { ids, action } = req.body;
        if (action === 'all') {
            await Instruction.destroy({ where: { UserId: req.user.id } });
        } else if (ids && Array.isArray(ids)) {
            await Instruction.destroy({ where: { id: ids, UserId: req.user.id } });
        }
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to delete instructions" });
    }
});

router.post('/chats/delete', async (req, res) => {
    try {
        const { remoteJid } = req.body;
        await Message.destroy({
            where: {
                remoteJid,
                UserId: req.user.id
            }
        });
        res.redirect('/dashboard/chats');
    } catch (err) {
        console.error(err);
        res.status(500).send("Error deleting chat");
    }
});

// ============================================
// Training / Simulator Routes (المرحلة الثالثة)
// ============================================

router.post('/training/setup-wizard', async (req, res) => {
    try {
        const { botName, businessType, firstServiceName, serviceDetails, serviceImageUrl, items } = req.body;
        
        // Handle Identity (if botName provided)
        if (botName) {
            const identityContent = `أنت موظف خدمة العملاء ومسؤول المبيعات. اسمك هو ${botName}. مهمتك مساعدة العملاء والإجابة على استفساراتهم باحترافية واحترام وود.`;
            
            // Check if identity exists
            let identityInst = await Instruction.findOne({ where: { UserId: req.user.id, type: 'global' } });
            if (identityInst) {
                identityInst.content = identityContent;
                identityInst.keywords = 'اسمك ايه, انت مين, وظيفتك, مين معايا';
                await identityInst.save();
            } else {
                await Instruction.create({
                    clientName: 'إعدادات عامة',
                    title: 'هوية البوت واسمه',
                    content: identityContent,
                    actionTarget: '',
                    imageUrl: '',
                    UserId: req.user.id,
                    keywords: 'اسمك ايه, انت مين, وظيفتك, مين معايا',
                    type: 'global'
                });
            }
        }

        // Process dynamic items list
        if (items && Array.isArray(items)) {
            for (const item of items) {
                if (item.name && item.details) {
                    const isService = item.type === 'خدمة';
                    const isProduct = item.type === 'منتج';
                    let serviceContent = '';
                    
                    if (isService) {
                        serviceContent = `نحن نقدم خدمة: ${item.name}.\nتفاصيل الخدمة والاستفادة منها: ${item.details}`;
                    } else if (isProduct) {
                        serviceContent = `نوفر لك المنتج الرائع: ${item.name}.\nالمواصفات والسعر: ${item.details}`;
                    } else {
                        serviceContent = `${item.name}: ${item.details}`;
                    }

                    let keywordsStr = `${item.name}, السعر, بكام, تفاصيل, معلومات عن`;
                    if (isProduct) keywordsStr += `, مقاس, الوان, متاح`;
                    else if (isService) keywordsStr += `, حجز, موعد, ميعاد`;

                    await Instruction.create({
                        clientName: isService ? 'الخدمات' : (isProduct ? 'المنتجات' : 'أخرى'),
                        title: item.name,
                        content: serviceContent,
                        actionTarget: '',
                        imageUrl: item.image || '',
                        UserId: req.user.id,
                        keywords: keywordsStr,
                        type: 'topic'
                    });
                }
            }
        }

        res.json({ success: true, message: 'تم حفظ الإعدادات بنجاح!' });
    } catch (err) {
        console.error("Setup Wizard Error:", err);
        res.status(500).json({ error: "Mission failed. Please try again." });
    }
});

router.get('/training', async (req, res) => {
    try {
        const messages = await SimulationMessage.findAll({
            where: { UserId: req.user.id },
            order: [['createdAt', 'ASC']]
        });
        
        const teachMessages = await TeachMessage.findAll({
            where: { UserId: req.user.id },
            order: [['createdAt', 'ASC']]
        });

        // Count tokens
        const user = await User.findByPk(req.user.id);
        const tokensUsed = user.total_tokens || 0;

        // ======================================================
        // 📚 المقترح 2 و 3: جلب التعليمات لعرض ID و Keywords
        // ======================================================
        const instructions = await Instruction.findAll({
            where: { UserId: req.user.id },
            order: [['order', 'ASC'], ['createdAt', 'DESC']],
            attributes: ['id', 'clientName', 'title', 'keywords', 'type', 'isActive', 'createdAt']
        });

        res.render('training', { 
            user: req.user, 
            page: 'training',
            messages,
            teachMessages,
            tokensUsed,
            instructions
        });
    } catch (err) {
        console.error("Training page error:", err);
        res.status(500).send("Error loading training page");
    }
});


router.post('/training/send', async (req, res) => {
    try {
        const { message } = req.body;
        if (!message) return res.status(400).json({ error: "Message is required" });

        // Save User Message to Training DB
        const savedMessage = await SimulationMessage.create({
            role: 'user',
            content: message,
            UserId: req.user.id
        });

        // Get AI Reply
        const aiReply = await simulateChat(req.user.id, message);

        // Save AI Reply to Training DB
        let aiSavedMessage = null;
        if (aiReply) {
            aiSavedMessage = await SimulationMessage.create({
                role: 'model',
                content: aiReply,
                UserId: req.user.id
            });
        }

        res.json({ success: true, aiReply: aiSavedMessage });
    } catch (err) {
        console.error("Training send error:", err);
        res.status(500).json({ error: "Failed to send message" });
    }
});

router.post('/training/clear', async (req, res) => {
    try {
        await SimulationMessage.destroy({
            where: { UserId: req.user.id }
        });
        res.json({ success: true });
    } catch (err) {
        console.error("Training clear error:", err);
        res.status(500).json({ error: "Failed to clear chat" });
    }
});

// Teach Bot Routes
router.post('/training/teach', async (req, res) => {
    try {
        const { message } = req.body;
        if (!message) return res.status(400).json({ error: "Message is required" });

        await TeachMessage.create({ role: 'user', content: message, UserId: req.user.id });

        const aiReply = await teachBot(req.user.id, message);

        let aiSavedMessage = null;
        if (aiReply) {
            aiSavedMessage = await TeachMessage.create({ role: 'model', content: aiReply, UserId: req.user.id });
        }

        res.json({ success: true, aiReply: aiSavedMessage });
    } catch (err) {
        console.error("Teach send error:", err);
        res.status(500).json({ error: "Failed to send message" });
    }
});

router.post('/training/clear-teach', async (req, res) => {
    try {
        await TeachMessage.destroy({ where: { UserId: req.user.id } });
        res.json({ success: true });
    } catch (err) {
        console.error("Teach clear error:", err);
        res.status(500).json({ error: "Failed to clear chat" });
    }
});




// Profile Routes
router.get('/profile', (req, res) => {
    if (req.user.role !== 'sales') {
        req.flash('error_msg', 'عذراً، صفحة الملف الشخصي متاحة فقط لموظفي المبيعات.');
        return res.redirect('/dashboard');
    }
    res.render('profile', { user: req.user, page: 'profile' });
});

router.post('/profile/password', async (req, res) => {
    if (req.user.role !== 'sales') {
        req.flash('error_msg', 'عذراً، هذا الإجراء متاح فقط لموظفي المبيعات.');
        return res.redirect('/dashboard');
    }
    try {
        const { currentPassword, newPassword, confirmPassword } = req.body;

        if (newPassword !== confirmPassword) {
            return res.render('profile', { user: req.user, page: 'profile', error: 'كلمة المرور الجديدة غير متطابقة!' });
        }

        const user = await User.findByPk(req.user.id);
        const isValid = await user.validPassword(currentPassword);

        if (!isValid) {
            return res.render('profile', { user: req.user, page: 'profile', error: 'كلمة المرور الحالية غير صحيحة!' });
        }

        user.password = newPassword;
        await user.save(); // Hooks will hash it

        res.render('profile', { user: req.user, page: 'profile', success: true });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error updating password");
    }
});


// Privacy Policy Route
router.get('/privacy', (req, res) => {
    res.render('privacy_policy', { user: req.user, page: 'privacy' });
});

// Image Upload Routes
router.post('/instructions/upload-image', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No image uploaded' });
        }

        // Compress and save image
        const imageUrl = await compressAndSaveImage(req.file);

        res.json({ imageUrl });
    } catch (err) {
        console.error('Upload error:', err);
        res.status(500).json({ error: 'Failed to upload image' });
    }
});

router.post('/instructions/delete-image', async (req, res) => {
    try {
        const { imageUrl } = req.body;
        deleteImage(imageUrl);
        res.json({ success: true });
    } catch (err) {
        console.error('Delete error:', err);
        res.status(500).json({ error: 'Failed to delete image' });
    }
});

// ============================================================
// 💬 LIVE CHAT - Human Handoff Routes
// ============================================================
router.get('/livechat', async (req, res) => {
    try {
        let targetUserId = req.user.id;
        if (req.user.role === 'sales') {
            const adminUser = await User.findOne({ where: { role: 'admin' } });
            if (adminUser) targetUserId = adminUser.id;
        }

        const conversations = await Conversation.findAll({
            where: { UserId: targetUserId },
            order: [['lastMessageAt', 'DESC']],
            limit: 100
        });
        const handoffCount = conversations.filter(c => c.is_handoff).length;
        res.render('livechat', {
            user: req.user,
            targetUserId,
            page: 'livechat',
            conversations: JSON.parse(JSON.stringify(conversations)),
            handoffCount
        });
    } catch (err) {
        console.error('LiveChat error:', err);
        res.status(500).send('Error loading live chat');
    }
});

router.get('/livechat/:remoteJid/messages', async (req, res) => {
    try {
        let targetUserId = req.user.id;
        if (req.user.role === 'sales') {
            const adminUser = await User.findOne({ where: { role: 'admin' } });
            if (adminUser) targetUserId = adminUser.id;
        }

        const { remoteJid } = req.params;
        const decodedJid = decodeURIComponent(remoteJid);
        const jids = [decodedJid];
        if (decodedJid.endsWith('@lid')) {
            const cust = await Customer.findOne({ where: { remoteJid: decodedJid } });
            if (cust?.phoneNumber) {
                jids.push(`${cust.phoneNumber}@s.whatsapp.net`);
            }
        } else if (decodedJid.endsWith('@s.whatsapp.net')) {
            const phone = decodedJid.split('@')[0];
            const cust = await Customer.findOne({ where: { phoneNumber: phone } });
            if (cust?.remoteJid && cust.remoteJid.endsWith('@lid')) {
                jids.push(cust.remoteJid);
            }
        }

        const messages = await Message.findAll({
            where: { UserId: targetUserId, remoteJid: { [Op.in]: jids } },
            order: [['createdAt', 'ASC']],
            limit: 70
        });
        // Reset unread count
        await Conversation.update(
            { unreadCount: 0 },
            { where: { UserId: targetUserId, remoteJid: { [Op.in]: jids } } }
        );
        res.json({ success: true, messages });
    } catch (err) {
        console.error('GetMessages error:', err);
        res.status(500).json({ error: 'Failed to load messages' });
    }
});

router.get('/livechat/api/conversations', async (req, res) => {
    try {
        let targetUserId = req.user.id;
        if (req.user.role === 'sales') {
            const adminUser = await User.findOne({ where: { role: 'admin' } });
            if (adminUser) targetUserId = adminUser.id;
        }

        const conversations = await Conversation.findAll({
            where: { UserId: targetUserId },
            order: [['lastMessageAt', 'DESC']],
            limit: 100
        });
        res.json({ success: true, conversations: JSON.parse(JSON.stringify(conversations)) });
    } catch (err) {
        console.error('GetConversations API error:', err);
        res.status(500).json({ error: err.message || 'Failed to load conversations' });
    }
});

const recentManualSendCache = new Map();

router.post('/livechat/send', async (req, res) => {
    try {
        const { remoteJid, text, quotedMsgId } = req.body;
        if (!remoteJid || !text) return res.status(400).json({ error: 'remoteJid and text required' });
        
        // منع التكرار على السيرفر في حال إرسال نقرتين متتاليتين
        const debounceKey = `${remoteJid}_${text.trim()}`;
        const lastSent = recentManualSendCache.get(debounceKey);
        if (lastSent && Date.now() - lastSent < 3000) {
            console.log(`⚠️ [Anti-Duplicate] منع إرسال رسالة مكررة في غضون 3 ثوانٍ لنفس العميل: "${text}"`);
            return res.json({ success: true, message: { content: text } });
        }
        recentManualSendCache.set(debounceKey, Date.now());
        setTimeout(() => recentManualSendCache.delete(debounceKey), 10000);

        // جلب العميل للتأكد من وجوده ومعرفة المالك الفعلي للجلسة
        let customer = await Customer.findOne({ where: { remoteJid } });
        if (!customer && remoteJid.includes('@')) {
            const phone = remoteJid.split('@')[0];
            customer = await Customer.findOne({ where: { phoneNumber: phone } });
        }
        if (!customer) {
            const conv = await Conversation.findOne({ where: { remoteJid } });
            if (conv && conv.CustomerId) {
                customer = await Customer.findByPk(conv.CustomerId);
            }
        }
        if (!customer) {
            return res.status(404).json({ error: 'العميل غير موجود' });
        }

        // إرسال الرسالة باستخدام معرف مالك الجلسة مع خيار الرد المقتبس
        const savedMsg = await sendManualMessage(customer.UserId, remoteJid, text, { quotedMsgId });
        
        const io = req.app.get('socketio');
        if (io) {
            const payload = {
                ...savedMsg.toJSON(),
                phoneNumber: customer.phoneNumber || null,
                customerName: customer.customerName || null
            };
            io.to(`user_${customer.UserId}`).emit('new_message', payload);
            io.to('crm_staff').emit('new_message', payload);
        }

        // تسجيل رد الموظف وسرعة الاستجابة في نظام الـ KPI تلقائياً
        try {
            const { recordResponse } = await import('../services/kpiService.js');
            await recordResponse(req.user.id, customer.id);
        } catch (kpiErr) {
            console.error('Error recording KPI response in /livechat/send:', kpiErr);
        }

        res.json({ success: true, message: savedMsg });
    } catch (err) {
        console.error('SendManual error:', err);
        res.status(500).json({ error: err.message || 'Failed to send message' });
    }
});

// إعداد مولتر لرفع وسائط اللايف شات
const livechatMediaStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(process.cwd(), 'public', 'uploads', 'media');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        const uniqueName = `livechat_${Date.now()}_${Math.round(Math.random() * 1E9)}${ext}`;
        cb(null, uniqueName);
    }
});

const uploadLivechatMedia = multer({
    storage: livechatMediaStorage,
    limits: { fileSize: 25 * 1024 * 1024 } // 25 MB max limit
});

router.post('/livechat/send-media', (req, res, next) => {
    uploadLivechatMedia.single('mediaFile')(req, res, (err) => {
        if (err) {
            console.error('Multer upload error in /livechat/send-media:', err);
            return res.status(400).json({ error: err.message || 'خطأ أثناء رفع الملف' });
        }
        next();
    });
}, async (req, res) => {
    try {
        const { remoteJid, caption, quotedMsgId } = req.body;
        if (!remoteJid) return res.status(400).json({ error: 'remoteJid required' });
        if (!req.file) return res.status(400).json({ error: 'لم يتم إرفاق أي ملف' });

        let customer = await Customer.findOne({ where: { remoteJid } });
        if (!customer && remoteJid.includes('@')) {
            const phone = remoteJid.split('@')[0];
            customer = await Customer.findOne({ where: { phoneNumber: phone } });
        }
        let conv = await Conversation.findOne({ where: { remoteJid } });
        if (!conv && remoteJid.includes('@')) {
            const phone = remoteJid.split('@')[0];
            conv = await Conversation.findOne({ where: { phoneNumber: phone } });
        }
        if (!customer && conv && conv.CustomerId) {
            customer = await Customer.findByPk(conv.CustomerId);
        }

        let botUserId = customer?.UserId || conv?.UserId || req.user.id;
        if (req.user.role === 'sales' && !customer?.UserId && !conv?.UserId) {
            const adminUser = await User.findOne({ where: { role: 'admin' } });
            if (adminUser) botUserId = adminUser.id;
        }

        const savedMsg = await sendManualMediaMessage(
            botUserId,
            remoteJid,
            req.file.path,
            req.file.mimetype,
            caption || '',
            { quotedMsgId }
        );

        const io = req.app.get('socketio');
        if (io) {
            const payload = {
                ...savedMsg.toJSON(),
                phoneNumber: customer?.phoneNumber || conv?.phoneNumber || null,
                customerName: customer?.customerName || conv?.customerName || null
            };
            io.to(`user_${botUserId}`).emit('new_message', payload);
            io.to('crm_staff').emit('new_message', payload);
        }

        if (customer) {
            try {
                const { recordResponse } = await import('../services/kpiService.js');
                await recordResponse(req.user.id, customer.id);
            } catch (kpiErr) {
                console.error('Error recording KPI response in /livechat/send-media:', kpiErr);
            }
        }

        res.json({ success: true, message: savedMsg });
    } catch (err) {
        console.error('SendMedia error:', err);
        res.status(500).json({ error: err.message || 'فشل إرسال الوسائط' });
    }
});

// تفاعل الإيموجي مع رسالة معينة في اللايف شات
router.post('/livechat/react', async (req, res) => {
    try {
        const { remoteJid, messageId, emoji } = req.body;
        if (!remoteJid || !messageId) {
            return res.status(400).json({ error: 'remoteJid and messageId required' });
        }

        let customer = await Customer.findOne({ where: { remoteJid } });
        if (!customer && remoteJid.includes('@')) {
            const phone = remoteJid.split('@')[0];
            customer = await Customer.findOne({ where: { phoneNumber: phone } });
        }
        let conv = await Conversation.findOne({ where: { remoteJid } });
        if (!customer && conv && conv.CustomerId) {
            customer = await Customer.findByPk(conv.CustomerId);
        }

        let botUserId = customer?.UserId || conv?.UserId || req.user.id;
        if (req.user.role === 'sales' && !customer?.UserId && !conv?.UserId) {
            const adminUser = await User.findOne({ where: { role: 'admin' } });
            if (adminUser) botUserId = adminUser.id;
        }

        const reactionResult = await sendReaction(botUserId, remoteJid, messageId, emoji);

        const io = req.app.get('socketio');
        if (io) {
            io.to(`user_${botUserId}`).emit('message_reaction', reactionResult);
            io.to('crm_staff').emit('message_reaction', reactionResult);
        }

        res.json({ success: true, ...reactionResult });
    } catch (err) {
        console.error('Reaction error in /livechat/react:', err);
        res.status(500).json({ error: err.message || 'فشل تحديث التفاعل' });
    }
});

router.post('/livechat/handoff', async (req, res) => {
    try {
        let targetUserId = req.user.id;
        if (req.user.role === 'sales') {
            const adminUser = await User.findOne({ where: { role: 'admin' } });
            if (adminUser) targetUserId = adminUser.id;
        }

        const { remoteJid, enable } = req.body;
        if (!remoteJid) return res.status(400).json({ error: 'remoteJid required' });
        await Conversation.update(
            { is_handoff: enable === true || enable === 'true' },
            { where: { UserId: targetUserId, remoteJid } }
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Handoff error:', err);
        res.status(500).json({ error: 'Failed to update handoff' });
    }
});

// ============================================================
// 📊 ANALYTICS ROUTES
// ============================================================
router.get('/analytics', async (req, res) => {
    try {
        const userId = req.user.id;
        const now = new Date();
        const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
        const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
        const today = new Date(); today.setHours(0,0,0,0);

        // Total messages
        const totalMessages = await Message.count({ where: { UserId: userId } });
        const inbound = await Message.count({ where: { UserId: userId, role: 'user' } });
        const outbound = await Message.count({ where: { UserId: userId, role: 'model' } });

        // Total unique conversations
        const totalConversations = await Conversation.count({ where: { UserId: userId } });
        const handoffCount = await Conversation.count({ where: { UserId: userId, is_handoff: true } });

        // Messages today
        const messagesToday = await Message.count({
            where: { UserId: userId, createdAt: { [Op.gte]: today } }
        });

        // Messages last 7 days per day (for chart)
        const last7Days = [];
        for (let i = 6; i >= 0; i--) {
            const dayStart = new Date(now); dayStart.setDate(dayStart.getDate() - i); dayStart.setHours(0,0,0,0);
            const dayEnd = new Date(dayStart); dayEnd.setHours(23,59,59,999);
            const count = await Message.count({
                where: { UserId: userId, createdAt: { [Op.between]: [dayStart, dayEnd] } }
            });
            last7Days.push({
                label: dayStart.toLocaleDateString('ar-EG', { weekday: 'short', numberingSystem: 'latn' }),
                count
            });
        }

        // Top instructions by keyword hits
        const instructions = await Instruction.findAll({
            where: { UserId: userId, isActive: true },
            attributes: ['id','clientName','keywords','type'],
            limit: 10,
            order: [['createdAt','DESC']]
        });

        // Token usage
        const user = await User.findByPk(userId);
        const tokensUsed = user.total_tokens || 0;

        res.render('analytics', {
            user: req.user,
            page: 'analytics',
            totalMessages,
            inbound,
            outbound,
            totalConversations,
            handoffCount,
            messagesToday,
            last7Days: JSON.stringify(last7Days),
            instructions,
            tokensUsed
        });
    } catch (err) {
        console.error('Analytics error:', err);
        res.status(500).send('Error loading analytics');
    }
});

// Analytics JSON API (for date filter)
router.get('/analytics/data', async (req, res) => {
    try {
        const userId = req.user.id;
        const days = parseInt(req.query.days) || 7;
        const now = new Date();
        const today = new Date(); today.setHours(0,0,0,0);
        const dateFilter = days > 0 ? { [Op.gte]: new Date(now - days * 24 * 60 * 60 * 1000) } : {};
        const msgWhere = days > 0 ? { UserId: userId, createdAt: dateFilter } : { UserId: userId };

        const totalMessages = await Message.count({ where: msgWhere });
        const inbound  = await Message.count({ where: { ...msgWhere, role: 'user' } });
        const outbound = await Message.count({ where: { ...msgWhere, role: 'model' } });
        const convWhere = days > 0 ? { UserId: userId, lastMessageAt: dateFilter } : { UserId: userId };
        const totalConversations = await Conversation.count({ where: convWhere });
        const handoffCount = await Conversation.count({ where: { ...convWhere, is_handoff: true } });
        const messagesToday = await Message.count({ where: { UserId: userId, createdAt: { [Op.gte]: today } } });

        // Chart: build N days of data
        const numDays = days > 0 ? Math.min(days, 90) : 30;
        const chartData = [];
        for (let i = numDays - 1; i >= 0; i--) {
            const dayStart = new Date(now); dayStart.setDate(dayStart.getDate() - i); dayStart.setHours(0,0,0,0);
            const dayEnd = new Date(dayStart); dayEnd.setHours(23,59,59,999);
            const count = await Message.count({ where: { UserId: userId, createdAt: { [Op.between]: [dayStart, dayEnd] } } });
            chartData.push({ label: dayStart.toLocaleDateString('ar-EG', { weekday: 'short', month: 'numeric', day: 'numeric', numberingSystem: 'latn' }), count });
        }

        res.json({ totalMessages, inbound, outbound, totalConversations, handoffCount, messagesToday, chartData });
    } catch (err) {
        console.error('Analytics Data API error:', err);
        res.status(500).json({ error: 'Failed to load analytics data' });
    }
});

// Broadcast Page
router.get('/broadcast', async (req, res) => {
    try {
        const userId = req.user.id;
        const campaigns = await Campaign.findAll({
            where: { UserId: userId },
            order: [['createdAt', 'DESC']]
        });
        const handoffCount = await Conversation.count({ where: { UserId: userId, is_handoff: true } });
        const targetCount = await Conversation.count({ where: { UserId: userId } });

        res.render('broadcast', {
            user: req.user,
            page: 'broadcast',
            campaigns,
            handoffCount,
            targetCount
        });
    } catch (err) {
        console.error('Broadcast page error:', err);
        res.status(500).send('Error loading broadcasts');
    }
});

// Multer configuration for Campaign Media uploads
const campaignStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = './public/uploads/broadcasts';
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        const ext = path.extname(file.originalname);
        cb(null, 'broadcast-' + uniqueSuffix + ext);
    }
});

const uploadCampaignMedia = multer({
    storage: campaignStorage,
    limits: { fileSize: 20 * 1024 * 1024 }, // 20MB max limit
    fileFilter: (req, file, cb) => {
        const allowedMimeTypes = [
            'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
            'video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/webm'
        ];
        if (allowedMimeTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('نوع الملف غير مدعوم. فقط الصور والفيديوهات مسموح بها.'));
        }
    }
});

// Broadcast API - Upload Campaign Media
router.post('/broadcast/upload-media', uploadCampaignMedia.single('mediaFile'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'لم يتم تحميل أي ملف' });
        }
        const mediaUrl = `/uploads/broadcasts/${req.file.filename}`;
        res.json({ success: true, mediaUrl });
    } catch (err) {
        console.error('Media upload error:', err);
        res.status(500).json({ success: false, error: err.message || 'فشل تحميل الملف' });
    }
});

// Broadcast API - Get target count by date range
router.get('/broadcast/target-count', async (req, res) => {
    try {
        const { dateFrom, dateTo, statuses } = req.query;
        const userId = req.user.id;

        const { Op } = await import('sequelize');
        const whereClause = { UserId: userId };

        if (dateFrom || dateTo) {
            whereClause.lastReplyAt = {};
            if (dateFrom) whereClause.lastReplyAt[Op.gte] = new Date(dateFrom);
            if (dateTo) whereClause.lastReplyAt[Op.lte] = new Date(new Date(dateTo).setHours(23, 59, 59, 999));
        }

        if (statuses && statuses.trim() !== '') {
            const statusArr = statuses.split(',').filter(s => s.trim() !== '');
            if (statusArr.length > 0) {
                whereClause.status = { [Op.in]: statusArr };
            }
        }

        const count = await Customer.count({ where: whereClause });
        res.json({ success: true, count });
    } catch (err) {
        console.error('Target count error:', err);
        res.status(500).json({ success: false, count: 0 });
    }
});

// Broadcast API - create and start/schedule a campaign
router.post('/broadcast/send', async (req, res) => {
    try {
        const userId = req.user.id;
        const { name, message, platform, contentType, mediaUrl, scheduledAt, targetFilter, minDelay, maxDelay, freezeAfter, freezeDuration } = req.body;
        
        if (!name || !message) {
            return res.status(400).json({ success: false, error: 'الاسم والرسالة مطلوبان' });
        }
        
        const plat = platform === 'messenger' ? 'messenger' : 'whatsapp';
        const delayMin = parseInt(minDelay, 10) || 30;
        const delayMax = parseInt(maxDelay, 10) || 60;
        const fAfter = parseInt(freezeAfter, 10) || 0;
        const fDuration = parseInt(freezeDuration, 10) || 0;
        const parsedScheduledAt = scheduledAt ? new Date(scheduledAt) : null;

        // Resolve targetFilter
        let filterObj = {};
        if (typeof targetFilter === 'string') {
            try { filterObj = JSON.parse(targetFilter); } catch (e) { filterObj = {}; }
        } else if (targetFilter) {
            filterObj = targetFilter;
        }

        // Identify targets
        const broadcastCtrl = await import('../controllers/broadcastController.js');
        const targets = await broadcastCtrl.getCampaignTargets(plat, filterObj, userId);
        
        if (targets.length === 0) {
            return res.status(400).json({ success: false, error: 'لا يوجد عملاء مطابقين لفلتر الاستهداف' });
        }

        const isScheduled = parsedScheduledAt && parsedScheduledAt > new Date();

        const campaign = await Campaign.create({
            name,
            message,
            platform: plat,
            contentType: contentType || 'text',
            mediaUrl: mediaUrl || null,
            targetFilter: filterObj,
            status: isScheduled ? 'pending' : 'running',
            targetCount: targets.length,
            scheduledAt: parsedScheduledAt,
            UserId: userId,
            freezeAfter: fAfter,
            freezeDuration: fDuration
        });

        if (isScheduled) {
            return res.json({ 
                success: true, 
                campaignId: campaign.id, 
                message: `تم جدولة الحملة بنجاح لـ ${targets.length} عميل في تاريخ ${parsedScheduledAt.toLocaleString('en-US', { hour12: true })}` 
            });
        }

        res.json({ success: true, campaignId: campaign.id, message: `بدأ الإرسال لـ ${targets.length} عميل` });

        // Background process to send messages
        const io = req.app.get('socketio');
        broadcastCtrl.runBroadcastCampaign(campaign.id, targets, message, userId, plat, delayMin, delayMax, io)
            .catch(err => {
                console.error('Error running broadcast campaign:', err);
            });

    } catch (err) {
        console.error('Broadcast send error:', err);
        res.status(500).json({ success: false, error: 'حدث خطأ أثناء بدء البث' });
    }
});

// Broadcast API - Get campaign recipients/messages details
router.get('/broadcast/campaign/:id/recipients', async (req, res) => {
    try {
        const campaignId = req.params.id;
        const userId = req.user.id;
        const { Op } = await import('sequelize');

        // Check ownership
        const campaign = await Campaign.findOne({ where: { id: campaignId, UserId: userId } });
        if (!campaign) {
            return res.status(404).json({ success: false, error: 'الحملة غير موجودة' });
        }

        // Fetch messages related to this campaign
        const messages = await Message.findAll({
            where: { CampaignId: campaignId, UserId: userId },
            order: [['createdAt', 'ASC']]
        });

        const remoteJids = messages.map(m => m.remoteJid);
        const customers = await Customer.findAll({
            where: {
                UserId: userId,
                remoteJid: { [Op.in]: remoteJids }
            }
        });

        const customerMap = {};
        customers.forEach(c => {
            customerMap[c.remoteJid] = {
                name: c.customerName,
                phone: c.phoneNumber
            };
        });

        const recipients = messages.map(m => {
            const cust = customerMap[m.remoteJid] || {};
            let phone = cust.phone;
            if (!phone) {
                const match = m.remoteJid.match(/^(\d+)/);
                phone = match ? match[1] : m.remoteJid;
            }
            return {
                id: m.id,
                name: cust.name || 'عميل غير مسجل',
                phone: phone,
                status: m.status,
                replied: m.replied,
                sentAt: m.createdAt
            };
        });

        res.json({ success: true, recipients });
    } catch (err) {
        console.error('Error fetching campaign recipients:', err);
        res.status(500).json({ success: false, error: 'حدث خطأ أثناء جلب تفاصيل المستلمين' });
    }
});

// Broadcast API - Cancel a campaign
router.post('/broadcast/campaign/:id/cancel', async (req, res) => {
    try {
        const campaignId = req.params.id;
        const userId = req.user.id;

        const campaign = await Campaign.findOne({ where: { id: campaignId, UserId: userId } });
        if (!campaign) {
            return res.status(404).json({ success: false, error: 'الحملة غير موجودة' });
        }

        if (campaign.status === 'completed' || campaign.status === 'failed' || campaign.status === 'cancelled') {
            return res.status(400).json({ success: false, error: 'لا يمكن إلغاء حملة منتهية بالفعل' });
        }

        campaign.status = 'cancelled';
        await campaign.save();

        // Emit update via socket
        const io = req.app.get('socketio');
        if (io) {
            io.to(`user_${userId}`).emit('campaign_progress', {
                campaignId: campaign.id,
                status: 'cancelled',
                sentCount: campaign.sentCount,
                failedCount: campaign.failedCount,
                targetCount: campaign.targetCount
            });
        }

        res.json({ success: true, message: 'تم إلغاء الحملة بنجاح' });
    } catch (err) {
        console.error('Error cancelling campaign:', err);
        res.status(500).json({ success: false, error: 'حدث خطأ أثناء إلغاء الحملة' });
    }
});

// Broadcast API - Export campaign recipients/messages details to Excel
router.get('/broadcast/campaign/:id/export-excel', async (req, res) => {
    try {
        const campaignId = req.params.id;
        const userId = req.user.id;
        const { search, status } = req.query; // Get filters
        const { Op } = await import('sequelize');

        // Check ownership
        const campaign = await Campaign.findOne({ where: { id: campaignId, UserId: userId } });
        if (!campaign) {
            return res.status(404).send('الحملة غير موجودة');
        }

        // Fetch messages related to this campaign
        const messages = await Message.findAll({
            where: { CampaignId: campaignId, UserId: userId },
            order: [['createdAt', 'ASC']]
        });

        const remoteJids = messages.map(m => m.remoteJid);
        const customers = await Customer.findAll({
            where: {
                UserId: userId,
                remoteJid: { [Op.in]: remoteJids }
            }
        });

        const customerMap = {};
        customers.forEach(c => {
            customerMap[c.remoteJid] = {
                name: c.customerName,
                phone: c.phoneNumber
            };
        });

        const recipients = messages.map(m => {
            const cust = customerMap[m.remoteJid] || {};
            let phone = cust.phone;
            if (!phone) {
                const match = m.remoteJid.match(/^(\d+)/);
                phone = match ? match[1] : m.remoteJid;
            }
            return {
                id: m.id,
                name: cust.name || 'عميل غير مسجل',
                phone: phone,
                status: m.status,
                replied: m.replied,
                sentAt: m.createdAt
            };
        });

        // Apply filtering matching client-side logic
        let filteredRecipients = recipients;
        if (status) {
            if (status === 'replied') {
                filteredRecipients = filteredRecipients.filter(r => r.replied);
            } else {
                filteredRecipients = filteredRecipients.filter(r => r.status === status && !r.replied);
            }
        }
        if (search && search.trim() !== '') {
            const q = search.toLowerCase().trim();
            filteredRecipients = filteredRecipients.filter(r => r.name.toLowerCase().includes(q) || r.phone.includes(q));
        }

        const { exportCampaignRecipientsToExcel } = await import('../services/exportService.js');
        const buffer = await exportCampaignRecipientsToExcel(filteredRecipients, campaign.name);

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="recipients_${campaignId}.xlsx"`);
        res.send(buffer);
    } catch (err) {
        console.error('Error exporting campaign recipients to excel:', err);
        res.status(500).send('حدث خطأ أثناء تصدير الملف.');
    }
});

// Toggle Inactivity Summary
router.post('/toggle-inactivity-summary', async (req, res) => {
    try {
        const user = await User.findByPk(req.user.id);
        if (!user) return res.status(404).json({ success: false });
        
        user.inactivity_summary = req.body.enabled;
        await user.save();
        
        res.json({ success: true });
    } catch (err) {
        console.error('Toggle inactivity summary error:', err);
        res.status(500).json({ success: false });
    }
});

// ======================================================
// 🔘 Interactive Buttons Routes
// ======================================================

// Buttons Page
router.get('/buttons', async (req, res) => {
    try {
        const userId = req.user.id;
        
        // Fetch all menus with their buttons (Admins/Super_Admins see menus across admin users)
        let menuWhere = { UserId: userId };
        let productWhere = { UserId: userId, isActive: true };
        if (req.user.role === 'super_admin' || req.user.role === 'admin') {
            const adminUsers = await User.findAll({
                where: { role: ['admin', 'super_admin'] },
                attributes: ['id']
            });
            const adminIds = adminUsers.map(u => u.id);
            menuWhere = { UserId: adminIds };
            productWhere = { UserId: adminIds, isActive: true };
        }

        const menus = await InteractiveMenu.findAll({
            where: menuWhere,
            include: [{
                model: InteractiveButton,
                order: [['order', 'ASC'], ['createdAt', 'ASC']]
            }],
            order: [['createdAt', 'ASC']]
        });
        
        const products = await Product.findAll({ where: productWhere, order: [['createdAt', 'DESC']] });
        const handoffCount = await Conversation.count({ where: { is_handoff: true } });
        const currentUser = await User.findByPk(userId);

        // Check if buttons are disabled (for current user, or any admin, or system setting)
        let buttonsDisabled = currentUser.buttons_disabled || false;
        try {
            const sysSetting = await SystemSettings.findOne({
                where: { settingKey: 'buttons_disabled' }
            });
            if (sysSetting) {
                buttonsDisabled = sysSetting.settingValue === 'true' || sysSetting.settingValue === '1';
            } else {
                const anyAdminDisabled = await User.findOne({
                    where: { role: ['admin', 'super_admin'], buttons_disabled: true }
                });
                if (anyAdminDisabled) buttonsDisabled = true;
            }
        } catch (e) {}

        res.render('interactive_buttons', { 
            user: req.user, 
            page: 'buttons', 
            menus, 
            products, 
            handoffCount, 
            botMode: currentUser.bot_mode || 'menu_only',
            buttonsDisabled
        });
    } catch (err) {
        console.error('Buttons page error:', err);
        res.status(500).send('Error loading buttons page');
    }
});

// Set Bot Mode
router.post('/set-bot-mode', async (req, res) => {
    try {
        const validModes = ['ai_only', 'hybrid', 'menu_only'];
        const newMode = req.body.mode;
        
        if (validModes.includes(newMode)) {
            // Update current user
            const user = await User.findByPk(req.user.id);
            if (user) {
                user.bot_mode = newMode;
                await user.save();
            }

            // Update all admin / super_admin users
            await User.update(
                { bot_mode: newMode },
                { where: { role: ['admin', 'super_admin'] } }
            );

            // Save to SystemSettings for all admins
            const adminUsers = await User.findAll({
                where: { role: ['admin', 'super_admin'] },
                attributes: ['id']
            });
            for (const adm of adminUsers) {
                await SystemSettings.upsert({
                    settingKey: 'bot_mode',
                    settingValue: newMode,
                    settingType: 'text',
                    category: 'general',
                    label: 'وضع تشغيل البوت',
                    UserId: adm.id
                });
            }

            console.log(`[Bot-Mode] User ${req.user.id} changed mode to: ${newMode} globally for all admins`);
            res.json({ success: true, mode: newMode });
        } else {
            res.status(400).json({ success: false, error: 'Invalid mode' });
        }
    } catch (err) {
        console.error('Set bot mode error:', err);
        res.status(500).json({ success: false });
    }
});

// Toggle Disable All Buttons
router.post('/buttons/toggle-disable-all', async (req, res) => {
    try {
        const isDisabled = req.body.disabled === true || req.body.disabled === 'true';
        
        // 1. Update current user
        const user = await User.findByPk(req.user.id);
        if (user) {
            user.buttons_disabled = isDisabled;
            await user.save();
        }

        // 2. Update all admin / super_admin users so all active bot sessions are synced!
        await User.update(
            { buttons_disabled: isDisabled },
            { where: { role: ['admin', 'super_admin'] } }
        );

        // 3. Save to SystemSettings for all admins
        const adminUsers = await User.findAll({
            where: { role: ['admin', 'super_admin'] },
            attributes: ['id']
        });
        for (const adm of adminUsers) {
            await SystemSettings.upsert({
                settingKey: 'buttons_disabled',
                settingValue: isDisabled ? 'true' : 'false',
                settingType: 'boolean',
                category: 'buttons',
                label: 'تعطيل ردود الأزرار بالكامل',
                UserId: adm.id
            });
        }
        
        console.log(`[Buttons-Disabled] User ${req.user.id} set buttons_disabled to: ${isDisabled} globally for all admins`);
        res.json({ success: true, buttons_disabled: isDisabled });
    } catch (err) {
        console.error('Toggle disable all buttons error:', err);
        res.status(500).json({ success: false });
    }
});

// ======================================================
// 📑 Menus CRUD
// ======================================================
router.post('/menus/add', async (req, res) => {
    try {
        const userId = req.user.id;
        const { menuName, triggerWords, welcomeMessage } = req.body;
        
        if (!menuName || !triggerWords) return res.redirect('/dashboard/buttons');
        
        await InteractiveMenu.create({
            UserId: userId,
            menuName,
            triggerWords,
            welcomeMessage: welcomeMessage || null
        });
        res.redirect('/dashboard/buttons');
    } catch(err) {
        console.error(err);
        res.redirect('/dashboard/buttons');
    }
});

router.post('/menus/edit', async (req, res) => {
    try {
        const userId = req.user.id;
        const { id, menuName, triggerWords, welcomeMessage } = req.body;
        
        const menuWhere = (req.user.role === 'admin' || req.user.role === 'super_admin') ? { id } : { id, UserId: userId };
        const menu = await InteractiveMenu.findOne({ where: menuWhere });
        if(menu) {
            menu.menuName = menuName;
            menu.triggerWords = triggerWords;
            menu.welcomeMessage = welcomeMessage || null;
            await menu.save();
        }
        res.redirect('/dashboard/buttons');
    } catch(err) {
        console.error(err);
        res.redirect('/dashboard/buttons');
    }
});

router.post('/menus/delete', async (req, res) => {
    try {
        const userId = req.user.id;
        const { id } = req.body;
        const menuWhere = (req.user.role === 'admin' || req.user.role === 'super_admin') ? { id } : { id, UserId: userId };
        await InteractiveMenu.destroy({ where: menuWhere });
        res.redirect('/dashboard/buttons');
    } catch(err) {
        console.error(err);
        res.redirect('/dashboard/buttons');
    }
});

router.post('/menus/set-default', async (req, res) => {
    try {
        const userId = req.user.id;
        const { id } = req.body;
        
        let targetMenu = await InteractiveMenu.findByPk(id);
        let targetUserId = targetMenu ? targetMenu.UserId : userId;

        // Remove default from all other menus
        await InteractiveMenu.update({ isDefault: false }, { where: { UserId: targetUserId } });
        
        // Set this menu as default
        await InteractiveMenu.update({ isDefault: true }, { where: { id } });
        
        res.redirect('/dashboard/buttons');
    } catch(err) {
        console.error(err);
        res.redirect('/dashboard/buttons');
    }
});

// Add Button
router.post('/buttons/add', upload.any(), async (req, res) => {
    try {
        const userId = req.user.id;
        const { label, responseText, responseImage, platform, continueToAI, order, MenuId, NextMenuId, ProductId } = req.body;

        if (!label || !responseText || !MenuId) {
            return res.redirect('/dashboard/buttons');
        }

        let finalImages = [];
        if (responseImage && responseImage.trim() !== '') {
             finalImages = responseImage.split(',').filter(i => i.trim() !== '');
        }

        if (req.files && req.files.length > 0) {
            for (const file of req.files) {
                const filename = await compressAndSaveImage(file);
                finalImages.push(filename.startsWith('/uploads/') ? filename : '/uploads/' + filename);
            }
        }

        // Auto-generate buttonId from label (safe, unique per user)
        const baseId = 'btn_' + label
            .replace(/[^\p{L}\p{N}\s]/gu, '')
            .trim()
            .replace(/\s+/g, '_')
            .substring(0, 30)
            .toLowerCase();
        // Ensure uniqueness by appending timestamp
        const buttonId = baseId + '_' + Date.now();

        await InteractiveButton.create({
            UserId: userId,
            MenuId: parseInt(MenuId),
            label: label.substring(0, 20), // Messenger limit
            buttonId,
            responseText,
            responseImage: finalImages.length > 0 ? finalImages.join(',') : null,
            platform: ['both', 'whatsapp', 'messenger'].includes(platform) ? platform : 'both',
            continueToAI: continueToAI === 'true',
            NextMenuId: NextMenuId ? parseInt(NextMenuId) : null,
            ProductId: ProductId ? parseInt(ProductId) : null,
            order: parseInt(order) || 0
        });

        res.redirect('/dashboard/buttons');
    } catch (err) {
        console.error('Add button error:', err);
        res.status(500).send('Error adding button');
    }
});

// Edit Button
router.post('/buttons/edit', upload.any(), async (req, res) => {
    try {
        const userId = req.user.id;
        const { id, label, responseText, responseImage, platform, continueToAI, order, NextMenuId, ProductId } = req.body;

        if (!id || !label || !responseText) {
            return res.redirect('/dashboard/buttons');
        }

        const btnWhere = (req.user.role === 'admin' || req.user.role === 'super_admin') ? { id } : { id, UserId: userId };
        const button = await InteractiveButton.findOne({ where: btnWhere });
        if (!button) return res.redirect('/dashboard/buttons');

        button.label = label.substring(0, 20);
        button.responseText = responseText;
        
        let existingImages = [];
        if (responseImage && responseImage.trim() !== '') {
            existingImages = responseImage.split(',').filter(i => i.trim() !== '');
        } else if (responseImage === '') { // Allow clearing image
            existingImages = [];
        } else if (button.responseImage && responseImage === undefined) {
             existingImages = button.responseImage.split(',').filter(i => i.trim() !== '');
        }

        if (req.files && req.files.length > 0) {
            for (const file of req.files) {
                const filename = await compressAndSaveImage(file);
                existingImages.push(filename.startsWith('/uploads/') ? filename : '/uploads/' + filename);
            }
        }
        
        button.responseImage = existingImages.length > 0 ? existingImages.join(',') : null;
        button.platform = ['both', 'whatsapp', 'messenger'].includes(platform) ? platform : 'both';
        button.continueToAI = continueToAI === 'true';
        button.NextMenuId = NextMenuId ? parseInt(NextMenuId) : null;
        button.ProductId = ProductId ? parseInt(ProductId) : null;
        button.order = parseInt(order) || 0;
        await button.save();

        res.redirect('/dashboard/buttons');
    } catch (err) {
        console.error('Edit button error:', err);
        res.status(500).send('Error editing button');
    }
});

// Delete Button
router.post('/buttons/delete', async (req, res) => {
    try {
        const userId = req.user.id;
        const { id } = req.body;

        if (!id) return res.redirect('/dashboard/buttons');

        const btnWhere = (req.user.role === 'admin' || req.user.role === 'super_admin') ? { id } : { id, UserId: userId };
        await InteractiveButton.destroy({ where: btnWhere });
        res.redirect('/dashboard/buttons');
    } catch (err) {
        console.error('Delete button error:', err);
        res.status(500).send('Error deleting button');
    }
});

// Toggle Button Active/Inactive
router.post('/buttons/toggle/:id', async (req, res) => {
    try {
        const userId = req.user.id;
        const { id } = req.params;

        const button = await InteractiveButton.findOne({ where: { id, UserId: userId } });
        if (!button) return res.redirect('/dashboard/buttons');

        button.isActive = !button.isActive;
        await button.save();

        res.redirect('/dashboard/buttons');
    } catch (err) {
        console.error('Toggle button error:', err);
        res.status(500).send('Error toggling button');
    }
});

// Reorder Buttons (API)
router.post('/buttons/reorder', async (req, res) => {
    try {
        const userId = req.user.id;
        const { buttonOrders } = req.body;

        if (!Array.isArray(buttonOrders)) {
            return res.status(400).json({ success: false, error: 'Invalid data' });
        }

        for (const item of buttonOrders) {
            if (item.id && typeof item.order === 'number') {
                await InteractiveButton.update(
                    { order: item.order },
                    { where: { id: item.id, UserId: userId } }
                );
            }
        }

        res.json({ success: true });
    } catch (err) {
        console.error('Reorder buttons error:', err);
        res.status(500).json({ success: false, error: 'Error reordering buttons' });
    }
});

// Settings Page
router.get('/settings', async (req, res) => {
    try {
        const userId = req.user.id;
        
        // Load all settings into an object
        const settings = {};
        const keys = Object.keys(defaultSettingsMeta);
        for (const key of keys) {
            settings[key] = await getSetting(key, userId);
        }

        let users = [];
        if (req.user.role === 'super_admin') {
            users = await User.findAll({ order: [['createdAt', 'DESC']] });
        }

        // WhatsApp connection status metrics
        const status = req.user.connection_status || 'offline';
        const phone = req.user.linked_phone_number || '';
        
        const handoffCount = await Conversation.count({ where: { UserId: userId, is_handoff: true } });

        res.render('settings', {
            user: req.user,
            page: 'settings',
            settings,
            users,
            status,
            phone,
            handoffCount,
            success_msg: req.flash('success_msg'),
            error_msg: req.flash('error_msg')
        });
    } catch (err) {
        console.error('Error rendering settings page:', err);
        res.status(500).send('حدث خطأ أثناء تحميل صفحة الإعدادات.');
    }
});

// Update Settings
router.post('/settings/update', async (req, res) => {
    try {
        const userId = req.user.id;
        const updates = req.body;
        
        const readOnlyKeys = ['welcome_message', 'course_details', 'free_lectures_url', 'free_lectures_message', 'guarantees_message', 'payment_instructions'];
        for (const [key, value] of Object.entries(updates)) {
            if (readOnlyKeys.includes(key)) {
                continue;
            }
            if (defaultSettingsMeta[key] !== undefined) {
                await setSetting(key, value, userId);
            }
        }

        req.flash('success_msg', 'تم حفظ الإعدادات بنجاح!');
        res.redirect('/dashboard/settings');
    } catch (err) {
        console.error('Error updating settings:', err);
        req.flash('error_msg', 'حدث خطأ أثناء حفظ الإعدادات.');
        res.redirect('/dashboard/settings');
    }
});

// Get connection status API
router.get('/settings/api-status', async (req, res) => {
    try {
        const status = req.user.connection_status || 'offline';
        const phone = req.user.linked_phone_number || '';
        res.json({ success: true, status, phone });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/settings/check-group', async (req, res) => {
    try {
        const userId = req.user.id;
        const status = await checkGacCrmGroup(userId);
        res.json({ success: true, status });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Helper to resolve the owner/primary admin of the system
async function getOwnerUser(reqUser) {
    try {
        const superAdmin = await User.findOne({ where: { role: 'super_admin' } });
        if (superAdmin) return superAdmin;

        const adminUser = await User.findOne({ where: { role: 'admin' } });
        if (adminUser) return adminUser;
    } catch (err) {
        console.error('Error finding owner user:', err);
    }
    return reqUser;
}

router.get('/employees', async (req, res) => {
    try {
        let Customer = null;
        try {
            const CustomerModule = await import('../models/Customer.js');
            Customer = CustomerModule.default;
        } catch (e) {
            // تجاهل خطأ التحميل إذا لم يكن الموديل قد تم إنشاؤه بعد (المرحلة 3)
        }

        const employees = await User.findAll({
            where: {
                role: { [Op.in]: ['admin', 'sales'] }
            },
            include: [
                {
                    model: User,
                    as: 'substituteUser',
                    attributes: ['id', 'fullName', 'username', 'role']
                }
            ],
            order: [['role', 'ASC'], ['fullName', 'ASC']]
        });

        // احتساب عدد العملاء لكل موظف
        for (let emp of employees) {
            if (Customer) {
                emp.customerCount = await Customer.count({ where: { assignedToUserId: emp.id } });
            } else {
                emp.customerCount = 0;
            }
        }

        // Fetch shift split rule using owner.id
        let shiftSplitRule = null;
        try {
            const owner = await getOwnerUser(req.user);
            shiftSplitRule = await getSetting('shift_split_rule', owner.id);
            if (!shiftSplitRule || !Array.isArray(shiftSplitRule.shifts) || shiftSplitRule.shifts.length === 0) {
                shiftSplitRule = {
                    enabled: shiftSplitRule ? shiftSplitRule.enabled : true,
                    defaultEmployeeId: (shiftSplitRule && shiftSplitRule.defaultEmployeeId) ? shiftSplitRule.defaultEmployeeId : null,
                    shifts: [
                        {
                            id: 'shift_1',
                            name: 'الفترة الصباحية',
                            startTime: '10:00',
                            endTime: '18:00',
                            days: ['السبت', 'الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس'],
                            employees: []
                        },
                        {
                            id: 'shift_2',
                            name: 'الفترة المسائية',
                            startTime: '18:00',
                            endTime: '23:00',
                            days: ['السبت', 'الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة'],
                            employees: []
                        },
                        {
                            id: 'shift_3',
                            name: 'الفترة الليلية حتى الصباح',
                            startTime: '23:00',
                            endTime: '10:00',
                            days: ['السبت', 'الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة'],
                            employees: []
                        }
                    ]
                };
            }
        } catch (e) {
            console.error('Error fetching shift split rule:', e);
        }

        res.render('employees', {
            user: req.user,
            page: 'employees',
            employees,
            shiftSplitRule,
            success_msg: req.flash('success_msg'),
            error_msg: req.flash('error_msg')
        });
    } catch (err) {
        console.error('Error fetching employees:', err);
        res.status(500).send('حدث خطأ أثناء تحميل بيانات صفحة الموظفين.');
    }
});

router.post('/employees/shift-split', async (req, res) => {
    try {
        const owner = await getOwnerUser(req.user);
        if (req.user.role !== 'super_admin' && req.user.role !== 'admin') {
            req.flash('error_msg', 'غير مصرح لك.');
            return res.redirect('/dashboard/employees');
        }

        const { enabled, defaultEmployeeId, shiftsData } = req.body;
        
        let shifts = [];
        if (shiftsData) {
            try {
                shifts = JSON.parse(shiftsData);
            } catch(e) {
                console.error('Error parsing shiftsData:', e);
            }
        }

        // تنظيف والتحقق من صحة بيانات الشيفتات
        if (Array.isArray(shifts)) {
            shifts = shifts.map((s, idx) => ({
                id: s.id || `shift_${idx + 1}_${Date.now()}`,
                name: s.name ? s.name.trim() : `فترة ${idx + 1}`,
                startTime: s.startTime || '09:00',
                endTime: s.endTime || '17:00',
                days: Array.isArray(s.days) ? s.days : [],
                employees: Array.isArray(s.employees) ? s.employees.map(Number).filter(Boolean) : []
            }));
        } else {
            shifts = [];
        }

        const rule = {
            enabled: enabled === 'on' || enabled === true || enabled === 'true',
            shifts,
            defaultEmployeeId: defaultEmployeeId ? Number(defaultEmployeeId) : null
        };

        await setSetting('shift_split_rule', rule, owner.id);
        req.flash('success_msg', 'تم حفظ قواعد توزيع العملاء والشيفتات بنجاح.');
        res.redirect('/dashboard/employees');
    } catch (err) {
        console.error('Error saving shift split rule:', err);
        req.flash('error_msg', 'حدث خطأ أثناء حفظ الشيفتات.');
        res.redirect('/dashboard/employees');
    }
});

router.post('/employees/add', async (req, res) => {
    try {
        const { fullName, phone, username, password, role, maxCustomers, substituteUserId } = req.body;

        const existingUser = await User.findOne({ where: { username } });
        if (existingUser) {
            req.flash('error_msg', 'اسم المستخدم موجود بالفعل. يرجى اختيار اسم مستخدم آخر.');
            return res.redirect('/dashboard/employees');
        }

        await User.create({
            fullName,
            phone,
            username,
            password,
            role,
            maxCustomers: parseInt(maxCustomers) || 999999,
            workStartTime: null,
            workEndTime: null,
            workDays: null,
            substituteUserId: substituteUserId ? parseInt(substituteUserId) : null,
            isOnLeave: false,
            is_active: true
        });

        req.flash('success_msg', 'تم إضافة الموظف بنجاح.');
        res.redirect('/dashboard/employees');
    } catch (err) {
        console.error('Error adding employee:', err);
        req.flash('error_msg', 'حدث خطأ أثناء إضافة الموظف.');
        res.redirect('/dashboard/employees');
    }
});

router.post('/employees/edit', async (req, res) => {
    try {
        const { id, fullName, phone, username, password, role, maxCustomers, substituteUserId } = req.body;

        const employee = await User.findByPk(id);
        if (!employee) {
            req.flash('error_msg', 'الموظف غير موجود.');
            return res.redirect('/dashboard/employees');
        }

        if (username !== employee.username) {
            const existingUser = await User.findOne({ where: { username } });
            if (existingUser) {
                req.flash('error_msg', 'اسم المستخدم مكرر لموظف آخر.');
                return res.redirect('/dashboard/employees');
            }
        }

        const updates = {
            fullName,
            phone,
            username,
            role,
            maxCustomers: parseInt(maxCustomers) || 999999,
            substituteUserId: substituteUserId ? parseInt(substituteUserId) : null
        };

        if (password && password.trim().length >= 6) {
            updates.password = password;
        }

        await employee.update(updates);

        req.flash('success_msg', 'تم تعديل بيانات الموظف بنجاح.');
        res.redirect('/dashboard/employees');
    } catch (err) {
        console.error('Error updating employee:', err);
        req.flash('error_msg', 'حدث خطأ أثناء تعديل الموظف.');
        res.redirect('/dashboard/employees');
    }
});

router.post('/employees/delete', async (req, res) => {
    try {
        const { id } = req.body;
        const employee = await User.findByPk(id);
        if (!employee) {
            req.flash('error_msg', 'الموظف غير موجود.');
            return res.redirect('/dashboard/employees');
        }

        if (employee.role === 'super_admin') {
            req.flash('error_msg', 'غير مسموح بحذف مدير النظام الرئيسي.');
            return res.redirect('/dashboard/employees');
        }

        // إزالة الموظف من الشيفتات تلقائياً حتى لا يتعطل توزيع البوت
        try {
            const owner = await getOwnerUser(req.user);
            const shiftSplitRule = await getSetting('shift_split_rule', owner.id);
            if (shiftSplitRule && Array.isArray(shiftSplitRule.shifts)) {
                let changed = false;
                shiftSplitRule.shifts.forEach(shift => {
                    if (Array.isArray(shift.employees) && shift.employees.map(Number).includes(Number(id))) {
                        shift.employees = shift.employees.map(Number).filter(empId => empId !== Number(id));
                        changed = true;
                    }
                });
                if (shiftSplitRule.defaultEmployeeId === Number(id)) {
                    shiftSplitRule.defaultEmployeeId = null;
                    changed = true;
                }
                if (changed) {
                    await setSetting('shift_split_rule', shiftSplitRule, owner.id);
                }
            }
        } catch (shiftErr) {
            console.error('Error removing deleted employee from shift split:', shiftErr);
        }

        let Customer = null;
        try {
            const CustomerModule = await import('../models/Customer.js');
            Customer = CustomerModule.default;
        } catch (e) {
            // تجاهل خطأ التحميل إذا لم يكن الموديل قد تم إنشاؤه بعد (المرحلة 3)
        }

        if (Customer) {
            const substituteId = employee.substituteUserId || null;
            await Customer.update(
                { assignedToUserId: substituteId },
                { where: { assignedToUserId: id } }
            );
        }

        await employee.destroy();
        req.flash('success_msg', 'تم حذف الموظف بنجاح.');
        res.redirect('/dashboard/employees');
    } catch (err) {
        console.error('Error deleting employee:', err);
        req.flash('error_msg', 'حدث خطأ أثناء حذف الموظف.');
        res.redirect('/dashboard/employees');
    }
});

router.post('/employees/toggle-leave/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const employee = await User.findByPk(id);
        if (!employee) {
            req.flash('error_msg', 'الموظف غير موجود.');
            return res.redirect('/dashboard/employees');
        }

        employee.isOnLeave = !employee.isOnLeave;
        await employee.save();

        if (employee.isOnLeave) {
            try {
                const { reassignOnLeave } = await import('../services/assignmentService.js');
                await reassignOnLeave(id);
            } catch (reassignErr) {
                console.error('Error during leave reassignment:', reassignErr);
            }
        }

        req.flash('success_msg', `تم تعديل حالة الإجازة للموظف، وهو الآن ${employee.isOnLeave ? 'في إجازة' : 'نشط'}.`);
        res.redirect('/dashboard/employees');
    } catch (err) {
        console.error('Error toggling leave state:', err);
        req.flash('error_msg', 'حدث خطأ أثناء تعديل حالة الإجازة.');
        res.redirect('/dashboard/employees');
    }
});

router.get('/customers', async (req, res) => {
    try {
        const employees = await User.findAll({
            where: {
                role: { [Op.in]: ['admin', 'sales'] }
            },
            order: [['fullName', 'ASC']]
        });
        
        res.render('customers', {
            user: req.user,
            page: 'customers',
            employees
        });
    } catch (err) {
        console.error('Error rendering customers page:', err);
        res.status(500).send('حدث خطأ أثناء تحميل صفحة العملاء.');
    }
});

router.post('/customers/add', async (req, res) => {
    try {
        const { customerName, phoneNumber, status, notes } = req.body;
        
        if (!phoneNumber || !phoneNumber.trim()) {
            return res.status(400).json({ success: false, error: 'رقم الهاتف مطلوب.' });
        }
        if (!customerName || !customerName.trim()) {
            return res.status(400).json({ success: false, error: 'اسم العميل مطلوب.' });
        }
        
        // Find owner ID (UserId)
        let ownerId = req.user.id;
        if (req.user.role === 'sales') {
            const adminUser = await User.findOne({ where: { role: 'admin' } });
            if (adminUser) {
                ownerId = adminUser.id;
            }
        }
        
        const cleanPhone = phoneNumber.replace(/\D/g, '');
        if (!cleanPhone) {
            return res.status(400).json({ success: false, error: 'رقم الهاتف غير صالح.' });
        }
        const remoteJid = `${cleanPhone}@s.whatsapp.net`;
        
        // Check if customer already exists for this UserId and phone number
        const existingCustomer = await Customer.findOne({
            where: { UserId: ownerId, phoneNumber: cleanPhone }
        });
        if (existingCustomer) {
            return res.status(400).json({ success: false, error: 'عذراً، هذا الرقم مسجل بالفعل لعميل آخر.' });
        }
        
        let assignedToUserId = null;
        let assignedAt = null;
        if (req.user.role === 'sales') {
            assignedToUserId = req.user.id;
            assignedAt = new Date();
        }
        
        let scheduledFollowUpAt = null;
        if (status === 'first_follow_up') {
            try {
                const firstFollowupDelay = await getSetting('first_followup_delay', ownerId);
                const firstFollowupDelayUnit = await getSetting('first_followup_delay_unit', ownerId) || 'hours';
                const firstFollowupDelayMs = firstFollowupDelayUnit === 'hours'
                    ? firstFollowupDelay * 60 * 60 * 1000
                    : firstFollowupDelay * 60 * 1000;
                scheduledFollowUpAt = new Date(Date.now() + (firstFollowupDelayMs || 0));
            } catch (err) {
                console.error('Error calculating first follow up date:', err);
            }
        }
        
        const customer = await Customer.create({
            customerName: customerName.trim(),
            phoneNumber: cleanPhone,
            remoteJid,
            status: status || 'new',
            notes: notes ? notes.trim() : null,
            UserId: ownerId,
            assignedToUserId,
            assignedAt,
            scheduledFollowUpAt,
            completedAt: status === 'successful' ? new Date() : null,
            firstContactAt: new Date()
        });
        
        // Find or create Conversation
        const existingConv = await Conversation.findOne({
            where: { UserId: ownerId, remoteJid }
        });
        if (existingConv) {
            existingConv.CustomerId = customer.id;
            if (!existingConv.customerName || existingConv.customerName === cleanPhone) {
                existingConv.customerName = customerName.trim();
            }
            await existingConv.save();
        } else {
            await Conversation.create({
                UserId: ownerId,
                remoteJid,
                platform: 'whatsapp',
                customerName: customerName.trim(),
                phoneNumber: cleanPhone,
                CustomerId: customer.id,
                lastMessageText: 'تم إضافة العميل يدوياً',
                lastMessageAt: new Date()
            });
        }
        
        // Log changes if applicable
        try {
            await logChange({
                UserId: req.user.id,
                action: 'create_customer',
                details: `تم إضافة العميل ${customerName.trim()} (${cleanPhone}) يدوياً وحالته: ${status || 'new'}`
            });
        } catch (logErr) {
            console.error('Error logging change for add customer:', logErr);
        }
        
        // Add notification if added by sales
        if (req.user.role === 'sales') {
            try {
                await createNotification({
                    type: 'system',
                    title: 'إضافة عميل يدوياً',
                    message: `قام الموظف ${req.user.fullName || req.user.username} بإضافة عميل جديد يدوياً: ${customerName.trim()}`,
                    targetUserId: ownerId,
                    customerId: customer.id,
                    ownerId: ownerId,
                    io: req.app.get('socketio')
                });
            } catch (notifErr) {
                console.error('Error sending notification for add customer:', notifErr);
            }
        }
        
        res.json({ success: true, customer });
    } catch (err) {
        console.error('Error adding customer:', err);
        res.status(500).json({ success: false, error: 'حدث خطأ أثناء إضافة العميل. يرجى المحاولة مرة أخرى.' });
    }
});

router.get('/customers/data', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const offset = (page - 1) * limit;
        
        const { status, employeeId, search, dateFrom, dateTo, todayFollowUps } = req.query;
        
        const whereClause = {};
        
        // Role-based filtering
        if (req.user.role === 'sales') {
            whereClause.assignedToUserId = req.user.id;
        } else {
            if (employeeId && employeeId !== 'all') {
                if (employeeId === 'unassigned') {
                    whereClause.assignedToUserId = null;
                } else {
                    whereClause.assignedToUserId = parseInt(employeeId);
                }
            }
            // By default, filter by owner (UserId = req.user.id)
            whereClause.UserId = req.user.id;
        }
        
        if (status && status !== 'all') {
            whereClause.status = status;
        }
        
        if (dateFrom || dateTo) {
            whereClause.firstContactAt = {};
            if (dateFrom) {
                whereClause.firstContactAt[Op.gte] = new Date(dateFrom);
            }
            if (dateTo) {
                whereClause.firstContactAt[Op.lte] = new Date(new Date(dateTo).setHours(23, 59, 59, 999));
            }
        }
        
        if (search && search.trim() !== '') {
            const searchVal = `%${search.trim()}%`;
            whereClause[Op.or] = [
                { phoneNumber: { [Op.like]: searchVal } },
                { customerName: { [Op.like]: searchVal } },
                { email: { [Op.like]: searchVal } },
                { notes: { [Op.like]: searchVal } }
            ];
        }

        if (todayFollowUps === 'true') {
            whereClause.scheduledFollowUpAt = { [Op.not]: null };
        }

        
        const { count, rows } = await Customer.findAndCountAll({
            where: whereClause,
            include: [
                {
                    model: User,
                    as: 'assignedTo',
                    attributes: ['id', 'fullName', 'username']
                }
            ],
            order: [['createdAt', 'DESC']],
            limit,
            offset
        });
        
        res.json({
            success: true,
            customers: rows,
            page,
            totalPages: Math.ceil(count / limit),
            totalCount: count
        });
    } catch (err) {
        console.error('Error fetching customers data:', err);
        res.status(500).json({ success: false, error: 'حدث خطأ أثناء جلب البيانات.' });
    }
});

router.post('/customers/update-status', async (req, res) => {
    try {
        const { id, status } = req.body;
        const customer = await Customer.findByPk(id);
        if (!customer) {
            return res.status(404).json({ success: false, error: 'العميل غير موجود' });
        }
        
        if (req.user.role === 'sales' && customer.assignedToUserId !== req.user.id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بتعديل هذا العميل' });
        }
        
        const oldStatus = customer.status;
        customer.status = status;
        if (status === 'successful') {
            customer.completedAt = new Date();
        }
        if (status === 'first_follow_up') {
            const firstFollowupDelay = await getSetting('first_followup_delay', customer.UserId);
            const firstFollowupDelayUnit = await getSetting('first_followup_delay_unit', customer.UserId) || 'hours';
            const firstFollowupDelayMs = firstFollowupDelayUnit === 'hours'
                ? firstFollowupDelay * 60 * 60 * 1000
                : firstFollowupDelay * 60 * 1000;
            customer.scheduledFollowUpAt = new Date(Date.now() + firstFollowupDelayMs);
        } else if (status === 'final_follow_up') {
            const finalFollowupDelay = await getSetting('final_followup_delay', customer.UserId);
            const finalFollowupDelayUnit = await getSetting('final_followup_delay_unit', customer.UserId) || 'hours';
            const finalFollowupDelayMs = finalFollowupDelayUnit === 'hours'
                ? finalFollowupDelay * 60 * 60 * 1000
                : finalFollowupDelay * 60 * 1000;
            customer.scheduledFollowUpAt = new Date(Date.now() + finalFollowupDelayMs);
        }

        await customer.save();

        // تحديث إحصائيات الحالة والعقد في نظام الـ KPI تلقائياً
        try {
            await recordStatusUpdate(req.user.id, customer.UserId);
            
            // لو العقد تم بنجاح، بنسجل الصفقة
            if (status === 'successful') {
                await recordContractClosed(customer.assignedToUserId || req.user.id, customer.id, customer.paymentAmount || 0);
            }
        } catch (kpiErr) {
            console.error('Error recording KPI stats in /customers/update-status:', kpiErr);
        }

        const getStatusLabel = (s) => {
            const labels = {
                'new': 'جديد',
                'in_funnel': 'داخل الفانل',
                'awaiting_payment': 'في انتظار الدفع',
                'awaiting_sales': 'في انتظار المبيعات',
                'first_follow_up': 'المتابعة الأولى',
                'final_follow_up': 'المتابعة النهائية',
                'scheduled_follow_up': 'متابعة بتاريخ مجدول',
                'successful': 'تم بنجاح (طالب)',
                'not_interested': 'غير مهتم'
            };
            return labels[s] || s;
        };

        // Log the change
        await logChange({
            action: 'status_change',
            description: `تغيير حالة العميل من "${getStatusLabel(oldStatus)}" إلى "${getStatusLabel(status)}"`,
            oldValue: oldStatus,
            newValue: status,
            customerId: customer.id,
            performedByUserId: req.user.id,
            ownerId: customer.UserId
        });

        if ((status === 'first_follow_up' || status === 'final_follow_up') && customer.scheduledFollowUpAt) {
            await logChange({
                action: 'schedule_followup',
                description: `تم تعيين / تغيير المتابعة إلى وقت وتاريخ ${new Date(customer.scheduledFollowUpAt).toLocaleString('en-US', { hour12: true })}`,
                customerId: customer.id,
                performedByUserId: req.user.id,
                ownerId: customer.UserId
            });
        }

        // إرسال إشعار للموظف المسؤول إذا تم التغيير بواسطة مستخدم آخر
        if (customer.assignedToUserId && customer.assignedToUserId !== req.user.id) {
            await createNotification({
                type: 'status_changed',
                title: 'تحديث حالة العميل',
                message: `قام ${req.user.fullName || req.user.username} بتغيير حالة عميلك "${customer.customerName || customer.phoneNumber}" إلى "${getStatusLabel(status)}"`,
                targetUserId: customer.assignedToUserId,
                customerId: customer.id,
                ownerId: customer.UserId,
                io: req.app.get('socketio')
            });
        }

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: 'حدث خطأ أثناء تحديث الحالة' });
    }
});

router.post('/customers/update-payment-status', async (req, res) => {
    try {
        const { id, paymentStatus } = req.body;
        
        const customer = await Customer.findByPk(id);
        if (!customer) {
            return res.status(404).json({ success: false, error: 'العميل غير موجود' });
        }
        
        if (req.user.role === 'sales' && customer.assignedToUserId !== req.user.id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك، هذا العميل غير مسند إليك.' });
        }
        
        const oldPaymentStatus = customer.paymentStatus;
        customer.paymentStatus = paymentStatus;
        
        let messageText = '';
        if (paymentStatus === 'confirmed') {
            customer.status = 'successful';
            customer.completedAt = new Date();
            messageText = `تم تأكيد الدفع للعميل وتحديث حالته إلى "تم بنجاح"`;
        } else if (paymentStatus === 'rejected') {
            messageText = `تم رفض الدفع للعميل`;
        } else {
            messageText = `تحديث حالة الدفع إلى "${paymentStatus}"`;
        }
        
        await customer.save();
        
        // تحديث إحصائيات العقد في نظام الـ KPI تلقائياً عند تأكيد الدفع
        if (paymentStatus === 'confirmed') {
            try {
                const { recordContractClosed } = await import('../services/kpiService.js');
                await recordContractClosed(customer.assignedToUserId || req.user.id, customer.id, customer.paymentAmount || 0);
            } catch (kpiErr) {
                console.error('Error recording KPI contract closed in /customers/update-payment-status:', kpiErr);
            }
            
            // إنشاء عملية إيراد تلقائياً في النظام المالي عند تأكيد الدفع
            try {
                await FinancialTransaction.create({
                    type: 'income',
                    amount: customer.paymentAmount || 0,
                    currency: 'EGP',
                    category: 'اشتراكات',
                    description: `اشتراك مؤكد للعميل: ${customer.customerName || customer.phoneNumber}`,
                    reference: customer.paymentMethod || 'تأكيد تلقائي',
                    CustomerId: customer.id,
                    recordedByUserId: req.user.id,
                    transactionDate: new Date().toISOString().split('T')[0],
                    UserId: customer.UserId
                });
            } catch (finErr) {
                console.error('Error creating automatic financial transaction in /customers/update-payment-status:', finErr);
            }
        }
        
        // Log the change
        await logChange({
            action: 'status_change',
            description: messageText,
            oldValue: oldPaymentStatus,
            newValue: paymentStatus,
            customerId: customer.id,
            performedByUserId: req.user.id,
            ownerId: customer.UserId
        });
        
        // Notify the customer on WhatsApp if confirmed or rejected
        try {
            const { sendManualMessage } = await import('../controllers/botController.js');
            if (paymentStatus === 'confirmed') {
                const confirmedMsg = `✅ تم تأكيد اشتراكك بنجاح! يسعدنا انضمامك إلينا. يمكنك الآن البدء في استخدام المنصة.`;
                await sendManualMessage(customer.UserId, customer.remoteJid, confirmedMsg);
            } else if (paymentStatus === 'rejected') {
                const rejectedMsg = `❌ عذراً، لم نتمكن من التحقق من إيصال الدفع المرسل. يرجى التأكد من صحة التحويل أو إرسال إيصال آخر صحيح.`;
                await sendManualMessage(customer.UserId, customer.remoteJid, rejectedMsg);
            }
        } catch (wsErr) {
            console.error('Error sending WhatsApp payment update notification to customer:', wsErr.message);
        }
        
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: 'حدث خطأ أثناء تحديث حالة الدفع' });
    }
});

const receiptStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(process.cwd(), 'public/uploads/receipts');
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const uploadReceipt = multer({
    storage: receiptStorage,
    limits: { fileSize: 10 * 1024 * 1024 }
});

router.post('/customers/upload-receipt', uploadReceipt.single('paymentReceipt'), async (req, res) => {
    try {
        const { id } = req.body;
        const customer = await Customer.findByPk(id);
        
        if (!customer) {
            return res.status(404).json({ success: false, error: 'العميل غير موجود' });
        }
        
        if (req.user.role === 'sales' && customer.assignedToUserId !== req.user.id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك، هذا العميل غير مسند إليك.' });
        }
        
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'يرجى اختيار ملف الإيصال' });
        }
        
        const receiptUrl = '/uploads/receipts/' + req.file.filename;
        customer.paymentReceiptUrl = receiptUrl;
        customer.paymentStatus = 'receipt_uploaded';
        await customer.save();
        
        await logChange({
            action: 'status_change',
            description: 'تم رفع إيصال الدفع للعميل',
            oldValue: 'pending',
            newValue: 'receipt_uploaded',
            customerId: customer.id,
            performedByUserId: req.user.id,
            ownerId: customer.UserId
        });
        
        res.json({ success: true, receiptUrl });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: 'حدث خطأ أثناء رفع الإيصال' });
    }
});

router.post('/customers/update-notes', async (req, res) => {
    try {
        const { id, notes } = req.body;
        const customer = await Customer.findByPk(id);
        if (!customer) {
            return res.status(404).json({ success: false, error: 'العميل غير موجود' });
        }
        
        if (req.user.role === 'sales' && customer.assignedToUserId !== req.user.id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بتعديل هذا العميل' });
        }
        
        const oldNotes = customer.notes;
        customer.notes = notes;
        await customer.save();

        // Log the change
        await logChange({
            action: 'note_added',
            description: oldNotes ? 'تحديث الملاحظات الخاصة بالعميل' : 'إضافة ملاحظة جديدة للعميل',
            oldValue: oldNotes,
            newValue: notes,
            customerId: customer.id,
            performedByUserId: req.user.id,
            ownerId: customer.UserId
        });

        // إرسال إشعار عند تحديث الملاحظات
        try {
            const noteSnippet = (notes || '').substring(0, 80);
            if (req.user.role === 'sales') {
                const notifyAdmin = await getSetting('notify_admin_on_customer_notes', customer.UserId);
                if (notifyAdmin === 'true' || notifyAdmin === true) {
                    await createNotification({
                        type: 'customer_note',
                        title: `ملاحظة جديدة من ${req.user.fullName || req.user.username}`,
                        message: `العميل "${customer.customerName || customer.phoneNumber}": ${noteSnippet}`,
                        targetUserId: customer.UserId,
                        customerId: customer.id,
                        ownerId: customer.UserId,
                        io: req.app.get('socketio')
                    });
                }
            } else if (customer.assignedToUserId && customer.assignedToUserId !== req.user.id) {
                await createNotification({
                    type: 'customer_note',
                    title: `ملاحظة جديدة من الإدارة`,
                    message: `العميل "${customer.customerName || customer.phoneNumber}": ${noteSnippet}`,
                    targetUserId: customer.assignedToUserId,
                    customerId: customer.id,
                    ownerId: customer.UserId,
                    io: req.app.get('socketio')
                });
            }
        } catch (notifErr) {
            console.error('Error sending customer_note notification:', notifErr);
        }

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: 'حدث خطأ أثناء تحديث الملاحظات' });
    }
});

router.post('/customers/assign', async (req, res) => {
    try {
        const { id, assignedToUserId } = req.body;
        
        if (req.user.role === 'sales') {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بتعيين الموظفين' });
        }
        
        const customer = await Customer.findByPk(id);
        if (!customer) {
            return res.status(404).json({ success: false, error: 'العميل غير موجود' });
        }
        
        const targetUserId = assignedToUserId ? parseInt(assignedToUserId) : null;
        const oldAssignedId = customer.assignedToUserId;

        let oldEmployeeName = 'غير معين';
        if (oldAssignedId) {
            const oldEmp = await User.findByPk(oldAssignedId);
            if (oldEmp) oldEmployeeName = oldEmp.fullName || oldEmp.username;
        }

        let newEmployeeName = 'غير معين';
        if (targetUserId) {
            const newEmp = await User.findByPk(targetUserId);
            if (newEmp) newEmployeeName = newEmp.fullName || newEmp.username;
        }

        customer.assignedToUserId = targetUserId;
        customer.assignedAt = targetUserId ? new Date() : null;
        await customer.save();

        // تسجيل تعيين الموظف في نظام الـ KPI تلقائياً
        if (targetUserId) {
            try {
                const { recordAssignment } = await import('../services/kpiService.js');
                await recordAssignment(targetUserId, customer.id);
            } catch (kpiErr) {
                console.error('Error recording KPI assignment in /customers/assign:', kpiErr);
            }
        }

        // Log the change
        await logChange({
            action: 'customer_assigned',
            description: `تعيين الموظف المسؤول للعميل من "${oldEmployeeName}" إلى "${newEmployeeName}"`,
            oldValue: oldAssignedId ? String(oldAssignedId) : null,
            newValue: targetUserId ? String(targetUserId) : null,
            customerId: customer.id,
            performedByUserId: req.user.id,
            ownerId: customer.UserId
        });

        // إرسال إشعار للموظف الجديد عبر لوحة التحكم
        if (targetUserId && targetUserId !== req.user.id) {
            await createNotification({
                type: 'customer_assigned',
                title: 'تعيين عميل جديد',
                message: `تم تعيين عميل جديد لك: "${customer.customerName || customer.phoneNumber}" بواسطة ${req.user.fullName || req.user.username}`,
                targetUserId,
                customerId: customer.id,
                ownerId: customer.UserId,
                io: req.app.get('socketio')
            });
        }

        // إرسال إشعار لجروب الواتساب الخاص بالعمل
        if (targetUserId) {
            const whatsappMsg = `📢 *تم تعيين عميل جديد!*\n\n👤 العميل: ${customer.customerName || 'عميل واتساب'}\n📞 الرقم: ${customer.phoneNumber}\n👨‍💼 الموظف المسؤول: ${newEmployeeName}\n🕐 وقت التعيين: ${new Date().toLocaleString('en-US', { hour12: true })}`;
            const { sendWhatsAppNotification } = await import('../services/notificationService.js');
            await sendWhatsAppNotification(customer.UserId, whatsappMsg);
        }

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: 'حدث خطأ أثناء تعيين الموظف' });
    }
});

router.post('/customers/schedule-followup', async (req, res) => {
    try {
        const { id, date } = req.body;
        const customer = await Customer.findByPk(id);
        if (!customer) {
            return res.status(404).json({ success: false, error: 'العميل غير موجود' });
        }
        
        if (req.user.role === 'sales' && customer.assignedToUserId !== req.user.id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بجدولة المتابعة لهذا العميل' });
        }
        
        const oldDate = customer.scheduledFollowUpAt;
        customer.scheduledFollowUpAt = date ? new Date(date) : null;
        if (date) {
            customer.status = 'scheduled_follow_up';
        }
        await customer.save();

        // تسجيل تحديث الحالة في نظام الـ KPI تلقائياً
        try {
            const { recordStatusUpdate } = await import('../services/kpiService.js');
            await recordStatusUpdate(req.user.id, customer.UserId);
        } catch (kpiErr) {
            console.error('Error recording KPI status update in /customers/schedule-followup:', kpiErr);
        }

        // Log the change
        await logChange({
            action: 'status_change',
            description: date 
                ? `جدولة متابعة للعميل بتاريخ ${new Date(date).toLocaleString('en-US', { hour12: true })} وتغيير الحالة إلى "متابعة بتاريخ"`
                : `إلغاء المتابعة المجدولة للعميل وتغيير الحالة إلى "متابعة بتاريخ"`,
            oldValue: oldDate ? new Date(oldDate).toISOString() : null,
            newValue: date ? new Date(date).toISOString() : null,
            customerId: customer.id,
            performedByUserId: req.user.id,
            ownerId: customer.UserId
        });

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: 'حدث خطأ أثناء جدولة المتابعة' });
    }
});

router.post('/customers/cancel-followup', ensureAuthenticated, async (req, res) => {
    try {
        const { customerId } = req.body;
        const customer = await Customer.findByPk(customerId);
        if (!customer) {
            return res.status(404).json({ success: false, error: 'العميل غير موجود' });
        }
        
        // Check permissions
        if (req.user.role === 'user' && customer.UserId !== req.user.id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }
        if (req.user.role === 'sales' && customer.assignedToUserId !== req.user.id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك' });
        }

        const oldDate = customer.scheduledFollowUpAt;
        if (!oldDate) {
            return res.json({ success: true });
        }

        customer.scheduledFollowUpAt = null;
        await customer.save();

        await logChange({
            action: 'cancel_followup',
            description: 'تم إلغاء المتابعة المجدولة',
            customerId: customer.id,
            performedByUserId: req.user.id,
            ownerId: customer.UserId
        });

        res.json({ success: true });
    } catch (err) {
        console.error('Error in cancel-followup:', err);
        res.status(500).json({ success: false, error: 'حدث خطأ أثناء إلغاء المتابعة' });
    }
});

router.post('/customers/:id/summarize', async (req, res) => {
    try {
        const { id } = req.params;
        const customer = await Customer.findByPk(id);
        if (!customer) {
            return res.status(404).json({ success: false, error: 'العميل غير موجود' });
        }

        // Check permission: Owner can do it, or assigned Sales employee can do it
        if (req.user.role === 'sales' && customer.assignedToUserId !== req.user.id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بتلخيص بيانات هذا العميل' });
        } else if (req.user.role !== 'sales' && customer.UserId !== req.user.id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بتلخيص بيانات هذا العميل' });
        }

        const summary = await generateCustomerSummary(customer.id, customer.UserId);
        res.json({ success: true, summary });
    } catch (err) {
        console.error('Error generating AI Summary:', err);
        res.status(500).json({ success: false, error: 'حدث خطأ أثناء تحليل المحادثة' });
    }
});

router.post('/customers/delete', async (req, res) => {
    try {
        // التحقق من الصلاحيات: متاح للمدراء فقط (super_admin / admin) وليس السيلز
        if (req.user.role !== 'super_admin' && req.user.role !== 'admin') {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بحذف العملاء. هذه الصلاحية للمدراء فقط.' });
        }

        const { id } = req.body;
        if (!id) {
            return res.status(400).json({ success: false, error: 'معرف العميل مطلوب.' });
        }

        const customer = await Customer.findByPk(id);
        if (!customer) {
            return res.status(404).json({ success: false, error: 'العميل غير موجود أو تم حذفه مسبقاً.' });
        }

        const ownerId = customer.UserId;
        const remoteJid = customer.remoteJid;
        const customerPhone = customer.phoneNumber;
        const custName = customer.customerName || customer.phoneNumber || `عميل #${customer.id}`;

        // 1. حذف جميع الرسائل الخاصة بهذا العميل في هذا الحساب
        const jidConditions = [];
        if (remoteJid) jidConditions.push(remoteJid);
        if (customerPhone) {
            jidConditions.push(`${customerPhone}@s.whatsapp.net`);
            jidConditions.push(`${customerPhone}@lid`);
        }
        if (jidConditions.length > 0) {
            await Message.destroy({
                where: {
                    UserId: ownerId,
                    remoteJid: { [Op.in]: jidConditions }
                }
            });
        }

        // 2. حذف المحادثة (Conversation)
        const convOr = [{ CustomerId: customer.id }];
        if (jidConditions.length > 0) {
            convOr.push({ remoteJid: { [Op.in]: jidConditions }, UserId: ownerId });
        }
        await Conversation.destroy({
            where: {
                [Op.or]: convOr
            }
        });

        // 3. حذف المتابعات (FollowUps)
        await FollowUp.destroy({
            where: { CustomerId: customer.id }
        });

        // 4. حذف سجل التغييرات للعميل (ChangeLogs)
        await ChangeLog.destroy({
            where: {
                [Op.or]: [
                    { CustomerId: customer.id },
                    { customerId: customer.id }
                ]
            }
        });

        // 5. حذف المعاملات المالية المرتبطة بالعميل
        await FinancialTransaction.destroy({
            where: { CustomerId: customer.id }
        });

        // 6. حذف الإشعارات المرتبطة بالعميل
        await Notification.destroy({
            where: { CustomerId: customer.id }
        });

        // 7. حذف ملف إيصال الدفع إن وجد
        if (customer.paymentReceiptUrl) {
            try {
                const filePath = path.join(process.cwd(), 'public', customer.paymentReceiptUrl);
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
            } catch (fileErr) {
                console.error('Error deleting receipt file:', fileErr);
            }
        }

        // 8. حذف سجل العميل نفسه
        await customer.destroy();

        // تسجيل عملية الحذف في سجل النظام العام
        try {
            await logChange({
                UserId: req.user.id,
                action: 'delete_customer',
                details: `قام ${req.user.fullName || req.user.username} بحذف العميل "${custName}" وجميع رسائله ومحادثاته وسجلاته بالكامل.`
            });
        } catch (logErr) {
            console.error('Error logging customer deletion:', logErr);
        }

        res.json({
            success: true,
            message: `تم حذف العميل "${custName}" وجميع المحادثات والرسائل الخاصة به بنجاح.`
        });
    } catch (err) {
        console.error('Error in /customers/delete:', err);
        res.status(500).json({ success: false, error: 'حدث خطأ أثناء حذف العميل. يرجى المحاولة مرة أخرى.' });
    }
});

router.get('/customers/export', async (req, res) => {
    try {
        if (req.user.role === 'sales') {
            return res.status(403).send('غير مصرح لك بتصدير بيانات العملاء.');
        }

        const { status, employeeId, search, dateFrom, dateTo, todayFollowUps } = req.query;
        const whereClause = {};

        if (todayFollowUps === 'true') {
            whereClause.status = 'scheduled_follow_up';
        }

        if (employeeId && employeeId !== 'all') {
            if (employeeId === 'unassigned') {
                whereClause.assignedToUserId = null;
            } else {
                whereClause.assignedToUserId = parseInt(employeeId);
            }
        } else {
            // Apply default ownership filter if not super_admin or admin
            if (req.user.role !== 'super_admin' && req.user.role !== 'admin') {
                whereClause.UserId = req.user.id;
            }
        }

        if (status && status !== 'all' && todayFollowUps !== 'true') {
            whereClause.status = status;
        }

        if (dateFrom || dateTo) {
            whereClause.firstContactAt = {};
            if (dateFrom) {
                whereClause.firstContactAt[Op.gte] = new Date(dateFrom);
            }
            if (dateTo) {
                whereClause.firstContactAt[Op.lte] = new Date(new Date(dateTo).setHours(23, 59, 59, 999));
            }
        }

        if (search && search.trim() !== '') {
            const searchVal = `%${search.trim()}%`;
            whereClause[Op.or] = [
                { phoneNumber: { [Op.like]: searchVal } },
                { customerName: { [Op.like]: searchVal } },
                { email: { [Op.like]: searchVal } },
                { notes: { [Op.like]: searchVal } }
            ];
        }

        const { exportCustomersToExcel } = await import('../services/exportService.js');
        const buffer = await exportCustomersToExcel(whereClause);

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="customers_export.xlsx"');
        res.send(buffer);
    } catch (err) {
        console.error('Error exporting customers:', err);
        res.status(500).send('حدث خطأ أثناء تصدير الملف.');
    }
});

router.get('/customers/:id', async (req, res) => {
    try {
        const customer = await Customer.findByPk(req.params.id, {
            include: [
                {
                    model: User,
                    as: 'assignedTo',
                    attributes: ['id', 'fullName', 'username']
                }
            ]
        });
        if (!customer) {
            return res.status(404).json({ success: false, error: 'العميل غير موجود' });
        }
        
        if (req.user.role === 'sales' && customer.assignedToUserId !== req.user.id) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بالوصول لهذا العميل' });
        }
        
        res.json({ success: true, customer });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: 'حدث خطأ أثناء جلب تفاصيل العميل' });
    }
});

router.get('/changelog', async (req, res) => {
    try {
        const employees = await User.findAll({
            where: {
                role: { [Op.in]: ['admin', 'sales'] }
            },
            order: [['fullName', 'ASC']]
        });
        
        res.render('changelog', {
            user: req.user,
            page: 'changelog',
            employees
        });
    } catch (err) {
        console.error('Error rendering changelog page:', err);
        res.status(500).send('حدث خطأ أثناء تحميل صفحة سجل التغييرات.');
    }
});

router.get('/changelog/data', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const offset = (page - 1) * limit;

        const { action, employeeId, search, dateFrom, dateTo } = req.query;

        const whereClause = {
            UserId: req.user.id // Only get logs for the bot owner
        };

        if (action && action !== 'all') {
            whereClause.action = action;
        }

        if (employeeId && employeeId !== 'all') {
            whereClause.performedByUserId = parseInt(employeeId);
        }

        if (dateFrom || dateTo) {
            whereClause.createdAt = {};
            if (dateFrom) {
                whereClause.createdAt[Op.gte] = new Date(dateFrom);
            }
            if (dateTo) {
                whereClause.createdAt[Op.lte] = new Date(new Date(dateTo).setHours(23, 59, 59, 999));
            }
        }

        const includeOptions = [
            {
                model: User,
                as: 'performer',
                attributes: ['id', 'fullName', 'username', 'role']
            }
        ];

        const customerWhere = {};
        if (search && search.trim() !== '') {
            const searchVal = `%${search.trim()}%`;
            customerWhere[Op.or] = [
                { phoneNumber: { [Op.like]: searchVal } },
                { customerName: { [Op.like]: searchVal } }
            ];
            includeOptions.push({
                model: Customer,
                as: 'customer',
                where: customerWhere,
                attributes: ['id', 'customerName', 'phoneNumber', 'remoteJid']
            });
        } else {
            includeOptions.push({
                model: Customer,
                as: 'customer',
                attributes: ['id', 'customerName', 'phoneNumber', 'remoteJid'],
                required: false
            });
        }

        const { count, rows } = await ChangeLog.findAndCountAll({
            where: whereClause,
            include: includeOptions,
            order: [['createdAt', 'DESC']],
            limit,
            offset
        });

        res.json({
            success: true,
            logs: rows,
            page,
            totalPages: Math.ceil(count / limit),
            totalCount: count
        });
    } catch (err) {
        console.error('Error fetching changelog data:', err);
        res.status(500).json({ success: false, error: 'حدث خطأ أثناء جلب سجل التغييرات.' });
    }
});

// Route الـ KPI الصحيح موجود في أسفل الملف (روتات نظام تقييم الأداء)

router.get('/finance', async (req, res) => {
    try {
        const whereClause = {};
        if (req.user.role !== 'super_admin') {
            whereClause.UserId = req.user.id;
        }
        
        // Fetch only the latest 10 customers to keep page loads fast
        const customers = await Customer.findAll({
            where: whereClause,
            attributes: ['id', 'customerName', 'phoneNumber'],
            order: [['id', 'DESC']],
            limit: 10
        });

        res.render('finance', {
            user: req.user,
            page: 'finance',
            customers,
            success_msg: req.flash('success_msg'),
            error_msg: req.flash('error_msg')
        });
    } catch (err) {
        console.error('Error rendering finance page:', err);
        res.status(500).send('حدث خطأ أثناء تحميل صفحة النظام المالي.');
    }
});

router.get('/finance/customers/search', async (req, res) => {
    try {
        const { query } = req.query;
        if (!query) {
            return res.json({ success: true, customers: [] });
        }

        const whereClause = {};
        if (req.user.role !== 'super_admin') {
            whereClause.UserId = req.user.id;
        }

        whereClause[Op.or] = [
            { phoneNumber: { [Op.like]: `%${query}%` } },
            { customerName: { [Op.like]: `%${query}%` } }
        ];

        const customers = await Customer.findAll({
            where: whereClause,
            attributes: ['id', 'customerName', 'phoneNumber'],
            order: [['id', 'DESC']],
            limit: 20
        });

        res.json({ success: true, customers });
    } catch (err) {
        console.error('Error searching customers:', err);
        res.status(500).json({ success: false, error: 'حدث خطأ أثناء البحث عن العملاء.' });
    }
});

router.get('/finance/data', async (req, res) => {
    try {
        const { filterType, dateFrom, dateTo } = req.query;
        const now = new Date();
        const whereClause = {};
        
        if (req.user.role !== 'super_admin') {
            whereClause.UserId = req.user.id;
        }

        if (filterType === 'today') {
            const todayStr = now.toISOString().split('T')[0];
            whereClause.transactionDate = todayStr;
        } else if (filterType === 'week') {
            // Get last 7 days starting from 7 days ago
            const sevenDaysAgo = new Date();
            sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
            const startOfWeekStr = sevenDaysAgo.toISOString().split('T')[0];
            const todayStr = now.toISOString().split('T')[0];
            whereClause.transactionDate = {
                [Op.between]: [startOfWeekStr, todayStr]
            };
        } else if (filterType === 'month') {
            const startOfMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
            const todayStr = now.toISOString().split('T')[0];
            whereClause.transactionDate = {
                [Op.between]: [startOfMonthStr, todayStr]
            };
        } else if (filterType === 'custom') {
            if (dateFrom && dateTo) {
                whereClause.transactionDate = {
                    [Op.between]: [dateFrom, dateTo]
                };
            }
        }

        // Fetch transactions matching filters
        const transactions = await FinancialTransaction.findAll({
            where: whereClause,
            include: [
                { model: Customer, as: 'customer', attributes: ['id', 'customerName', 'phoneNumber'] },
                { model: User, as: 'recorder', attributes: ['id', 'fullName', 'username'] }
            ],
            order: [['transactionDate', 'DESC'], ['id', 'DESC']]
        });
        
        // Calculate summary statistics
        let totalIncome = 0;
        let totalExpense = 0;
        transactions.forEach(t => {
            const amount = parseFloat(t.amount) || 0;
            if (t.type === 'income') {
                totalIncome += amount;
            } else {
                totalExpense += amount;
            }
        });
        const netProfit = totalIncome - totalExpense;

        // Fetch last 12 months data for Chart.js
        const twelveMonthsAgo = new Date();
        twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 11);
        twelveMonthsAgo.setDate(1);
        const startTwelveStr = twelveMonthsAgo.toISOString().split('T')[0];
        
        const chartWhere = {
            transactionDate: {
                [Op.gte]: startTwelveStr
            }
        };
        if (req.user.role !== 'super_admin') {
            chartWhere.UserId = req.user.id;
        }
        
        const chartTransactions = await FinancialTransaction.findAll({
            where: chartWhere,
            attributes: ['type', 'amount', 'transactionDate']
        });

        // Initialize 12-month data object
        const monthlyData = {};
        for (let i = 0; i < 12; i++) {
            const d = new Date();
            d.setMonth(d.getMonth() - 11 + i);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            const monthLabel = d.toLocaleDateString('ar-EG', { month: 'long', year: 'numeric', numberingSystem: 'latn' });
            monthlyData[key] = {
                label: monthLabel,
                income: 0,
                expense: 0
            };
        }
        
        // Group by month
        chartTransactions.forEach(t => {
            const dateStr = t.transactionDate;
            const key = dateStr.substring(0, 7);
            if (monthlyData[key]) {
                const amt = parseFloat(t.amount) || 0;
                if (t.type === 'income') {
                    monthlyData[key].income += amt;
                } else {
                    monthlyData[key].expense += amt;
                }
            }
        });
        
        const chartLabels = [];
        const chartIncome = [];
        const chartExpense = [];
        Object.keys(monthlyData).sort().forEach(key => {
            chartLabels.push(monthlyData[key].label);
            chartIncome.push(monthlyData[key].income);
            chartExpense.push(monthlyData[key].expense);
        });

        res.json({
            success: true,
            transactions,
            summary: {
                totalIncome,
                totalExpense,
                netProfit
            },
            chart: {
                labels: chartLabels,
                income: chartIncome,
                expense: chartExpense
            }
        });
    } catch (err) {
        console.error('Error fetching financial data:', err);
        res.status(500).json({ success: false, error: 'حدث خطأ أثناء جلب البيانات المالية.' });
    }
});

router.post('/finance/add', async (req, res) => {
    try {
        const { type, amount, category, description, transactionDate, reference, CustomerId } = req.body;
        
        await FinancialTransaction.create({
            type,
            amount: Math.round(parseFloat(amount)),
            currency: 'EGP',
            category,
            description,
            reference: reference || null,
            CustomerId: CustomerId ? parseInt(CustomerId) : null,
            recordedByUserId: req.user.id,
            transactionDate: transactionDate || new Date().toISOString().split('T')[0],
            UserId: req.user.id
        });
        
        req.flash('success_msg', 'تم تسجيل العملية المالية بنجاح.');
        res.redirect('/dashboard/finance');
    } catch (err) {
        console.error('Error adding financial transaction:', err);
        req.flash('error_msg', 'حدث خطأ أثناء تسجيل العملية المالية.');
        res.redirect('/dashboard/finance');
    }
});

router.post('/finance/edit', async (req, res) => {
    try {
        const { id, type, amount, category, description, transactionDate, reference, CustomerId } = req.body;
        
        const transaction = await FinancialTransaction.findByPk(id);
        if (!transaction) {
            req.flash('error_msg', 'العملية المالية غير موجودة.');
            return res.redirect('/dashboard/finance');
        }
        
        if (req.user.role !== 'super_admin' && transaction.UserId !== req.user.id) {
            req.flash('error_msg', 'غير مصرح لك بتعديل هذه العملية.');
            return res.redirect('/dashboard/finance');
        }
        
        await transaction.update({
            type,
            amount: Math.round(parseFloat(amount)),
            category,
            description,
            reference: reference || null,
            CustomerId: CustomerId ? parseInt(CustomerId) : null,
            transactionDate: transactionDate || transaction.transactionDate
        });
        
        req.flash('success_msg', 'تم تعديل العملية المالية بنجاح.');
        res.redirect('/dashboard/finance');
    } catch (err) {
        console.error('Error editing financial transaction:', err);
        req.flash('error_msg', 'حدث خطأ أثناء تعديل العملية المالية.');
        res.redirect('/dashboard/finance');
    }
});

router.post('/finance/delete', async (req, res) => {
    try {
        const { id } = req.body;
        
        if (req.user.role !== 'super_admin') {
            req.flash('error_msg', 'غير مصرح بحذف العمليات المالية إلا للمدير العام فقط (Super Admin).');
            return res.redirect('/dashboard/finance');
        }
        
        const transaction = await FinancialTransaction.findByPk(id);
        if (!transaction) {
            req.flash('error_msg', 'العملية المالية غير موجودة.');
            return res.redirect('/dashboard/finance');
        }
        
        await transaction.destroy();
        req.flash('success_msg', 'تم حذف العملية المالية بنجاح.');
        res.redirect('/dashboard/finance');
    } catch (err) {
        console.error('Error deleting financial transaction:', err);
        req.flash('error_msg', 'حدث خطأ أثناء حذف العملية المالية.');
        res.redirect('/dashboard/finance');
    }
});

router.get('/finance/export', async (req, res) => {
    try {
        const { filterType, dateFrom, dateTo } = req.query;
        const now = new Date();
        const whereClause = {};
        
        if (req.user.role !== 'super_admin') {
            whereClause.UserId = req.user.id;
        }

        if (filterType === 'today') {
            whereClause.transactionDate = now.toISOString().split('T')[0];
        } else if (filterType === 'week') {
            const sevenDaysAgo = new Date();
            sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
            whereClause.transactionDate = {
                [Op.between]: [sevenDaysAgo.toISOString().split('T')[0], now.toISOString().split('T')[0]]
            };
        } else if (filterType === 'month') {
            const startOfMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
            whereClause.transactionDate = {
                [Op.between]: [startOfMonthStr, now.toISOString().split('T')[0]]
            };
        } else if (filterType === 'custom') {
            if (dateFrom && dateTo) {
                whereClause.transactionDate = {
                    [Op.between]: [dateFrom, dateTo]
                };
            }
        }

        const transactions = await FinancialTransaction.findAll({
            where: whereClause,
            include: [
                { model: Customer, as: 'customer', attributes: ['id', 'customerName', 'phoneNumber'] },
                { model: User, as: 'recorder', attributes: ['id', 'fullName', 'username'] }
            ],
            order: [['transactionDate', 'DESC'], ['id', 'DESC']]
        });

        const { exportFinancialTransactionsToExcel } = await import('../services/exportService.js');
        const buffer = await exportFinancialTransactionsToExcel(transactions);

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="financial_report.xlsx"');
        res.send(buffer);
    } catch (err) {
        console.error('Error exporting financial report:', err);
        res.status(500).send('حدث خطأ أثناء تصدير تقرير العمليات المالية.');
    }
});

// ==========================================
// 🔔 روتات نظام الإشعارات الداخلية والـ Web Push
// ==========================================
router.get('/notifications', async (req, res) => {
    try {
        const { getEmployeesPushStatus, getVapidPublicKey } = await import('../services/webPushService.js');
        const { getSetting } = await import('../services/settingsService.js');
        const employeesPushStatus = await getEmployeesPushStatus(req.user.role, req.user.id);
        const vapidPublicKey = getVapidPublicKey();
        const notifyAdminOnNotes = await getSetting('notify_admin_on_customer_notes', req.user.id);

        res.render('notifications', {
            user: req.user,
            page: 'notifications',
            employeesPushStatus,
            vapidPublicKey,
            notifyAdminOnNotes: notifyAdminOnNotes !== false
        });
    } catch (err) {
        console.error('Error rendering notifications page:', err);
        res.status(500).send('حدث خطأ أثناء تحميل صفحة الإشعارات.');
    }
});

router.get('/push/public-key', async (req, res) => {
    try {
        const { getVapidPublicKey } = await import('../services/webPushService.js');
        res.json({ success: true, publicKey: getVapidPublicKey() });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/push/subscribe', async (req, res) => {
    try {
        const { subscription } = req.body;
        if (!subscription || !subscription.endpoint) {
            return res.status(400).json({ success: false, error: 'بيانات الاشتراك غير صالحة' });
        }
        const userAgent = req.headers['user-agent'] || '';
        const { saveSubscription } = await import('../services/webPushService.js');
        const saved = await saveSubscription({
            userId: req.user.id,
            subscription,
            userAgent
        });
        res.json({ success: true, message: 'تم تفعيل إشعارات هذا الجهاز بنجاح!', subscriptionId: saved.id });
    } catch (err) {
        console.error('Error subscribing to web push:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/push/unsubscribe', async (req, res) => {
    try {
        const { endpoint } = req.body;
        const { removeSubscription } = await import('../services/webPushService.js');
        await removeSubscription({ endpoint, userId: req.user.id });
        res.json({ success: true, message: 'تم إلغاء تفعيل الإشعارات لهذا الجهاز.' });
    } catch (err) {
        console.error('Error unsubscribing web push:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/push/test', async (req, res) => {
    try {
        const targetUserId = (req.body.userId && (req.user.role === 'admin' || req.user.role === 'super_admin'))
            ? parseInt(req.body.userId)
            : req.user.id;

        const { sendPushToUser } = await import('../services/webPushService.js');
        const result = await sendPushToUser(targetUserId, {
            title: '🔔 إشعار تجريبي من GAC CRM',
            body: `مرحباً بك! إشعارات الويب بوش تعمل بنجاح على جهازك (حساب: ${req.user.fullName || req.user.username}).`,
            icon: '/gac_crm_logo.png',
            badge: '/gac_crm_logo.png',
            data: { url: '/dashboard/notifications' }
        });

        if (result.sent === 0 && result.total === 0) {
            return res.json({
                success: false,
                message: 'لا يوجد أي جهاز أو متصفح مفعّل لهذا المستخدم حالياً. يرجى تفعيل الإشعار أولاً من المتصفح أو الموبايل.'
            });
        }

        res.json({
            success: true,
            message: `تم إرسال الإشعار التجريبي بنجاح إلى ${result.sent} جهاز.`,
            result
        });
    } catch (err) {
        console.error('Error sending test push:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/push/test-subscription/:subId', async (req, res) => {
    try {
        const subId = parseInt(req.params.subId);
        const { sendPushToSubscriptionId } = await import('../services/webPushService.js');
        await sendPushToSubscriptionId(subId, {
            title: '🔔 إشعار تجريبي لهذا الجهاز',
            body: 'جهازك متصل ومستعد لاستقبال إشعارات الرسائل والعملاء الجدد في الخلفية.',
            icon: '/gac_crm_logo.png',
            badge: '/gac_crm_logo.png',
            data: { url: '/dashboard/notifications' }
        });
        res.json({ success: true, message: 'تم إرسال الإشعار التجريبي للجهاز المحدد بنجاح!' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/notifications/unread-count', async (req, res) => {
    try {
        const count = await getUnreadCount(req.user.id);
        res.json({ success: true, count });
    } catch (err) {
        console.error('Error getting unread count:', err);
        res.status(500).json({ success: false, error: 'حدث خطأ أثناء جلب عدد الإشعارات.' });
    }
});

router.get('/notifications/data', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        
        const result = await getNotifications(req.user.id, page, limit);
        
        res.json({
            success: true,
            notifications: result.notifications,
            page: result.page,
            totalPages: result.totalPages,
            totalCount: result.totalCount
        });
    } catch (err) {
        console.error('Error getting notifications data:', err);
        res.status(500).json({ success: false, error: 'حدث خطأ أثناء جلب الإشعارات.' });
    }
});

router.post('/notifications/mark-read', async (req, res) => {
    try {
        const { id, all } = req.body;
        
        if (all === 'true' || all === true) {
            await markAllAsRead(req.user.id);
            return res.json({ success: true });
        }
        
        if (!id) {
            return res.status(400).json({ success: false, error: 'معرف الإشعار مطلوب' });
        }
        
        const success = await markAsRead(parseInt(id), req.user.id);
        res.json({ success });
    } catch (err) {
        console.error('Error marking notification as read:', err);
        res.status(500).json({ success: false, error: 'حدث خطأ أثناء تحديث حالة الإشعار.' });
    }
});

router.post('/notifications/toggle-notes-push', async (req, res) => {
    try {
        if (req.user.role !== 'admin' && req.user.role !== 'super_admin') {
            return res.status(403).json({ success: false, error: 'غير مصرح لك بتعديل هذا الإعداد' });
        }
        const { enabled } = req.body;
        const { setSetting } = await import('../services/settingsService.js');
        await setSetting('notify_admin_on_customer_notes', !!enabled, req.user.id);
        res.json({ success: true, enabled: !!enabled });
    } catch (err) {
        console.error('Error toggling admin notes push setting:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================
// 📊 روتات نظام تقييم الأداء (KPI)
// ==========================================
router.get('/kpi', async (req, res) => {
    try {
        res.render('kpi', {
            user: req.user,
            page: 'kpi'
        });
    } catch (err) {
        console.error('Error rendering KPI page:', err);
        res.status(500).send('حدث خطأ أثناء تحميل صفحة تقييم الأداء.');
    }
});

router.get('/kpi/data', async (req, res) => {
    try {
        const { dateFrom, dateTo, period, periodType } = req.query;
        const { getAllEmployeesKPI } = await import('../services/kpiService.js');
        
        const kpis = await getAllEmployeesKPI(req.user.id, {
            dateFrom: dateFrom || null,
            dateTo: dateTo || null,
            period: period || null,
            periodType: periodType || null
        });

        res.json({ success: true, kpis });
    } catch (err) {
        console.error('Error fetching KPI data:', err);
        res.status(500).json({ success: false, error: 'حدث خطأ أثناء جلب إحصائيات تقييم الأداء.' });
    }
});

router.get('/kpi/export', async (req, res) => {
    try {
        const { dateFrom, dateTo, period, periodType } = req.query;
        const { getAllEmployeesKPI } = await import('../services/kpiService.js');
        
        const kpis = await getAllEmployeesKPI(req.user.id, {
            dateFrom: dateFrom || null,
            dateTo: dateTo || null,
            period: period || null,
            periodType: periodType || null
        });

        // حساب الفترة الزمنية لتسمية الملف وإضافتها داخل الإكسيل
        let dateRangeStr = '';
        let dateRangeArabic = '';
        if (dateFrom && dateTo) {
            dateRangeStr = `${dateFrom}_to_${dateTo}`;
            dateRangeArabic = `من ${dateFrom} إلى ${dateTo}`;
        } else if (period) {
            if (periodType === 'daily') {
                dateRangeStr = period;
                dateRangeArabic = `يوم ${period}`;
            } else if (periodType === 'monthly') {
                const parts = period.split('-');
                const year = parseInt(parts[0]);
                const month = parseInt(parts[1]);
                const lastDay = new Date(year, month, 0).getDate();
                dateRangeStr = `${period}-01_to_${period}-${lastDay}`;
                dateRangeArabic = `من ${period}-01 إلى ${period}-${lastDay}`;
            }
        } else {
            const thisMonth = new Date().toISOString().substring(0, 7);
            const parts = thisMonth.split('-');
            const year = parseInt(parts[0]);
            const month = parseInt(parts[1]);
            const lastDay = new Date(year, month, 0).getDate();
            dateRangeStr = `${thisMonth}-01_to_${thisMonth}-${lastDay}`;
            dateRangeArabic = `من ${thisMonth}-01 إلى ${thisMonth}-${lastDay}`;
        }

        const { exportKPIToExcel } = await import('../services/exportService.js');
        const buffer = await exportKPIToExcel(kpis, dateRangeArabic);

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="kpi_report_${dateRangeStr}.xlsx"`);
        res.send(buffer);
    } catch (err) {
        console.error('Error exporting KPI report:', err);
        res.status(500).send('حدث خطأ أثناء تصدير تقرير الأداء.');
    }
});

export default router;
