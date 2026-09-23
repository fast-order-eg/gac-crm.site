import sequelize from './config/database.js';
import Customer from './models/Customer.js';
import User from './models/User.js';

async function run() {
    try {
        await sequelize.authenticate();
        console.log('Connection has been established successfully.');
        
        // Add column if it doesn't exist
        try {
            await sequelize.query('ALTER TABLE `customers` ADD COLUMN `customerNumber` INTEGER NULL COMMENT "رقم تسلسلي للعميل خاص بكل مستخدم";');
            console.log('Added customerNumber column.');
        } catch (e) {
            console.log('Column might already exist:', e.message);
        }

        // Fetch all users to update their customers
        const users = await User.findAll();
        for (const user of users) {
            const customers = await Customer.findAll({
                where: { UserId: user.id },
                order: [['createdAt', 'ASC']]
            });
            let number = 1;
            for (const customer of customers) {
                if (customer.customerNumber !== number) {
                    await customer.update({ customerNumber: number });
                }
                number++;
            }
        }
        console.log('Customer numbers updated successfully.');
        process.exit(0);
    } catch (error) {
        console.error('Unable to connect to the database:', error);
        process.exit(1);
    }
}

run();
