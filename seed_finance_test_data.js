import sequelize from './config/database.js';
import FinancialTransaction from './models/FinancialTransaction.js';
import Customer from './models/Customer.js';
import User from './models/User.js';

(async () => {
    try {
        await sequelize.authenticate();
        console.log('Database connected.');

        // Find the user "احمد سمير" (username: '1') or fallback to admin
        const adminUser = await User.findOne({ where: { username: '1' } }) || await User.findOne({ where: { username: 'admin' } });
        const userId = adminUser ? adminUser.id : 2;

        // Find existing customers
        const customers = await Customer.findAll({ limit: 5 });
        const cIds = customers.map(c => c.id);

        const getCustId = (idx) => (cIds.length > idx ? cIds[idx] : null);

        // Transactions to seed
        const transactions = [
            {
                type: 'income',
                amount: 4500,
                category: 'كورس ألماني',
                transactionDate: '2026-06-01',
                description: 'كورس اللغة الألمانية للمبتدئين A1',
                CustomerId: getCustId(0),
                recordedByUserId: userId,
                UserId: userId
            },
            {
                type: 'income',
                amount: 3200,
                category: 'اشتراكات',
                transactionDate: '2026-06-05',
                description: 'اشتراك شهري في المنصة التعليمية',
                CustomerId: getCustId(1),
                recordedByUserId: userId,
                UserId: userId
            },
            {
                type: 'expense',
                amount: 1500,
                category: 'إعلانات',
                transactionDate: '2026-06-08',
                description: 'إعلانات ممولة على فيسبوك وإنستجرام',
                CustomerId: null,
                recordedByUserId: userId,
                UserId: userId
            },
            {
                type: 'income',
                amount: 5000,
                category: 'كورس ألماني',
                transactionDate: '2026-06-10',
                description: 'كورس المحادثة الألمانية المتقدم B2',
                CustomerId: getCustId(2),
                recordedByUserId: userId,
                UserId: userId
            },
            {
                type: 'expense',
                amount: 8000,
                category: 'رواتب',
                transactionDate: '2026-05-30',
                description: 'رواتب موظفي الدعم الفني والمبيعات للشهر الماضي',
                CustomerId: null,
                recordedByUserId: userId,
                UserId: userId
            },
            {
                type: 'income',
                amount: 6000,
                category: 'كورس ألماني',
                transactionDate: '2026-05-15',
                description: 'كورس ألماني المستوى المتوسط B1',
                CustomerId: getCustId(3),
                recordedByUserId: userId,
                UserId: userId
            },
            {
                type: 'expense',
                amount: 2500,
                category: 'إعلانات',
                transactionDate: '2026-05-20',
                description: 'حملة إعلانية ممولة على تيك توك وجوجل',
                CustomerId: null,
                recordedByUserId: userId,
                UserId: userId
            },
            {
                type: 'income',
                amount: 3500,
                category: 'اشتراكات',
                transactionDate: '2026-04-10',
                description: 'اشتراكات مبيعات البوت الربع سنوية',
                CustomerId: getCustId(4),
                recordedByUserId: userId,
                UserId: userId
            },
            {
                type: 'expense',
                amount: 1200,
                category: 'أخرى',
                transactionDate: '2026-06-12',
                description: 'شراء قرطاسية وأدوات مكتبية وتجهيزات',
                CustomerId: null,
                recordedByUserId: userId,
                UserId: userId
            },
            {
                type: 'income',
                amount: 4000,
                category: 'اشتراكات',
                transactionDate: '2026-06-18',
                description: 'اشتراك سنوي لأحد العملاء المميزين',
                CustomerId: getCustId(0),
                recordedByUserId: userId,
                UserId: userId
            },
            {
                type: 'expense',
                amount: 3500,
                category: 'رواتب',
                transactionDate: '2026-04-30',
                description: 'مكافآت مبيعات الموظفين المتميزين',
                CustomerId: null,
                recordedByUserId: userId,
                UserId: userId
            },
            {
                type: 'income',
                amount: 2200,
                category: 'أخرى',
                transactionDate: '2026-06-19',
                description: 'عائد بيع مواد تعليمية وكتب إضافية',
                CustomerId: getCustId(1),
                recordedByUserId: userId,
                UserId: userId
            }
        ];

        for (const t of transactions) {
            await FinancialTransaction.create(t);
        }

        console.log('Successfully seeded 12 financial transactions.');
        process.exit(0);
    } catch (err) {
        console.error('Error seeding data:', err);
        process.exit(1);
    }
})();
