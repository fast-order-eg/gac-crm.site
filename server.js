import express from 'express';
import session from 'express-session';
import { restoreSessions, checkSubscriptionExpiry, checkPauseTimer, checkInactivitySummary, checkNoActionCustomers, generateDailyKPI } from './controllers/botController.js';
import { checkScheduledFollowUps, checkPendingFollowUps } from './services/followUpService.js';
import cron from 'node-cron';
import { checkScheduledCampaigns } from './controllers/broadcastController.js';

// ... (code)

// ... (imports continued)

import passport from 'passport';
import flash from 'connect-flash';
import { createServer } from 'http';
import { Server } from 'socket.io';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';


import sequelize from './config/database.js';
import passportConfig from './config/passport.js';
import User from './models/User.js';
import Message from './models/Message.js';
import Customer from './models/Customer.js';
import Conversation from './models/Conversation.js';
import Campaign from './models/Campaign.js';
import Instruction from './models/Instruction.js';
import MessengerPage from './models/MessengerPage.js';
import MessengerConversation from './models/MessengerConversation.js';
import SimulationMessage from './models/SimulationMessage.js';
import TeachMessage from './models/TeachMessage.js';
import Product from './models/Product.js';
import InteractiveButton from './models/InteractiveButton.js';
import ChangeLog from './models/ChangeLog.js';
import Notification from './models/Notification.js';
import SystemSettings from './models/SystemSettings.js';
import KPIRecord from './models/KPIRecord.js';
import FinancialTransaction from './models/FinancialTransaction.js';
import FollowUp from './models/FollowUp.js';
// Routes
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import apiDashboardRoutes from './routes/api_dashboard.js';
import dashboardRoutes from './routes/dashboard.js';
import messengerRoutes from './routes/messenger.js';

dotenv.config();

// ====== منع وقوع السيرفر من Baileys أو أي unhandled errors ======
process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ [Server] Unhandled Rejection (muted to prevent crash):', reason?.message || reason);
});

process.on('uncaughtException', (err) => {
    console.error('⚠️ [Server] Uncaught Exception (muted to prevent crash):', err?.message || err);
});



// Fix __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: ["http://localhost:3000", "http://localhost:3001"], // Allow Next.js
        methods: ["GET", "POST"]
    }
});

// CORS Middleware for Express
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (origin === 'http://localhost:3000' || origin === 'http://localhost:3001')) {
        res.header('Access-Control-Allow-Origin', origin);
    }
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Make io accessible in routes
app.set('socketio', io);

// View Engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// Global Rate limiter
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200, // limit each IP to 200 requests per windowMs
    message: "Too many requests from this IP, please try again after 15 minutes",
    standardHeaders: true,
    legacyHeaders: false,
});
app.use(limiter);

// Parser
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Session
app.use(session({
    secret: process.env.SESSION_SECRET || 'secret',
    resave: false,
    saveUninitialized: false
}));

// Passport
passportConfig(passport);
app.use(passport.initialize());
app.use(passport.session());

// Flash
app.use(flash());

// Global Middleware for Views
app.use((req, res, next) => {
    res.locals.user = req.user || null;
    next();
});

// Health Check for Zero-Downtime Monitoring
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// Routes
app.use('/', authRoutes);
app.use('/admin', adminRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/api/bot', apiDashboardRoutes);
app.use('/', messengerRoutes); // Messenger Webhook + Dashboard routes

app.use((err, req, res, next) => {
    console.error('⚠️ [Server Error Handled] Error:', err.message, 'Code:', err.code, 'Field:', err.field);
    console.error(err.stack);
    res.status(500).send('Something broke. System error.');
});


// Socket.io
io.on('connection', (socket) => {
    console.log('New client connected');

    socket.on('join_room', (room) => {
        socket.join(room);
        console.log(`Client joined room: ${room}`);
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected');
    });
});

// Database & Start
const PORT = process.env.PORT || 3005;

// --- Scheduled Cron Jobs ---
// Run bot cron jobs
cron.schedule('* * * * *', async () => {
    try {
        await checkScheduledFollowUps(io);
    } catch (e) {
        console.error('[Cron Error] checkScheduledFollowUps:', e.message);
    }

    try {
        await checkPendingFollowUps(io);
    } catch (e) {
        console.error('[Cron Error] checkPendingFollowUps:', e.message);
    }

    try {
        await checkNoActionCustomers(io);
    } catch (e) {
        console.error('[Cron Error] checkNoActionCustomers:', e.message);
    }

    try {
        await checkScheduledCampaigns(io);
    } catch (e) {
        console.error('[Cron Error] checkScheduledCampaigns:', e.message);
    }
});

// Run daily KPI report at midnight
cron.schedule('0 0 * * *', async () => {
    try {
        console.log('[Cron] Generating daily KPI report...');
        await generateDailyKPI();
    } catch (e) {
        console.error('[Cron Error] generateDailyKPI:', e.message);
    }
});

// Database & Server
const syncDb = process.env.DB_SYNC === 'true';
const dbPromise = syncDb ? sequelize.sync({ alter: true }) : sequelize.authenticate();

dbPromise.then(async () => {
    console.log(syncDb ? 'Database synced (with alter)' : 'Database connected successfully.');

    // Create Super Admin if not exists
    const adminExists = await User.findOne({ where: { role: 'super_admin' } });
    if (!adminExists) {
        const adminUser = await User.create({
            username: 'admin',
            password: 'admin123', // Change this!
            role: 'super_admin'
        });
        console.log('Super Admin created: admin / admin123');
        try {
            const { seedDefaults } = await import('./services/settingsService.js');
            await seedDefaults(adminUser.id);
            console.log(`[Settings] Default settings seeded for admin ${adminUser.id}`);
        } catch (seedErr) {
            console.error('Error seeding default settings:', seedErr);
        }
    } else {
        try {
            const { seedDefaults } = await import('./services/settingsService.js');
            await seedDefaults(adminExists.id);
            console.log(`[Settings] Default settings verified for admin ${adminExists.id}`);
        } catch (seedErr) {
            console.error('Error seeding default settings:', seedErr);
        }
    }

    httpServer.listen(PORT, () => {
        console.log(`🚀 [V6_SIGNATURE] Server running on http://localhost:${PORT}`);

        // Notify PM2 process manager that app is ready (for zero-downtime reloads)
        if (process.send) {
            process.send('ready');
        }

        // ⚠️ تم التفعيل بناءً على طلبك لتعمل على السيرفر (ممكن توقفها محلياً لو بتعمل تيست)
        restoreSessions(io);

        // Initial Checks
        checkSubscriptionExpiry(io);
        checkPauseTimer(io);

        // Schedule Checks every 1 hour (Subscription)
        setInterval(() => {
            checkSubscriptionExpiry(io);
        }, 60 * 60 * 1000);

        // Schedule Checks every 1 minute (Pause Timer)
        setInterval(() => {
            checkPauseTimer(io);
        }, 60 * 1000);

        // Schedule Inactivity Summary every 1 minute
        setInterval(() => {
            checkInactivitySummary();
        }, 60 * 1000);
    });
}).catch(err => {
    console.error('Database connection failed:', err);
});

// Graceful Shutdown for Zero-Downtime Reloads
const gracefulShutdown = (signal) => {
    console.log(`🛑 [Server] Received ${signal}. Starting graceful shutdown...`);
    httpServer.close(() => {
        console.log('✅ [Server] HTTP and Socket.IO connections closed.');
        sequelize.close().then(() => {
            console.log('✅ [Server] Database connection closed.');
            process.exit(0);
        }).catch(() => process.exit(0));
    });

    setTimeout(() => {
        console.error('⚠️ [Server] Forced shutdown after timeout.');
        process.exit(1);
    }, 4000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

