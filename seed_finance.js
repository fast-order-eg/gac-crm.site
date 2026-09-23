import sequelize from './config/database.js';
import FinancialTransaction from './models/FinancialTransaction.js';
import Customer from './models/Customer.js';
import User from './models/User.js';

(async () => {
    try {
        await sequelize.authenticate();
        
        // Find existing user to associate as recorder
        const user = await User.findOne();
        const userId = user ? user.id : 1;
        
        // Find some existing customers
        const customers = await Customer.findAll({ limit: 2 });
        const c1 = customers.length > 0 ? customers[0].id : null;
        const c2 = customers.length > 1 ? customers[1].id : null;

        // Transactions to seed
        const transactions = [
            {
                type: 'income',
                amount: 1500,
                category: 'اشتراكات',
                transactionDate: new Date('2026-06-15').toISOString().split('T')[0],
                description: 'اشتراك شهري',
                CustomerId: c1,
                recordedByUserId: userId,
                UserId: userId
            },
            {
                type: 'expense',
                amount: 500,
                category: 'إعلانات',
                transactionDate: new Date('2026-06-16').toISOString().split('T')[0],
                description: 'إعلانات فيسبوك',
                CustomerId: null,
                recordedByUserId: userId,
                UserId: userId
            },
            {
                type: 'income',
                amount: 3000,
                category: 'اشتراكات',
                transactionDate: new Date('2026-06-17').toISOString().split('T')[0],
                description: 'اشتراك سنوي',
                CustomerId: c2,
                recordedByUserId: userId,
                UserId: userId
            },
            {
                type: 'expense',
                amount: 1000,
                category: 'أخرى',
                transactionDate: new Date().toISOString().split('T')[0],
                description: 'مشتريات مكتبية ومستلزمات',
                CustomerId: null,
                recordedByUserId: userId,
                UserId: userId
            }
        ];

        for (const t of transactions) {
            await FinancialTransaction.create(t);
        }

        console.log('Finance transactions seeded successfully.');
        process.exit(0);
    } catch(e) {
        console.error(e);
        process.exit(1);
    }
})();
