import sequelize from './config/database.js';
import User from './models/User.js';
import bcrypt from 'bcrypt';

(async () => {
    try {
        await sequelize.authenticate();
        
        const hashPass = await bcrypt.hash('sales123', 10);
        
        // Employee 1 (Evening Shift)
        await User.create({
            fullName: 'موظف مسائي',
            phone: '01000000001',
            username: 'sales_evening',
            password: hashPass,
            role: 'sales',
            maxCustomers: 999999,
            workStartTime: '17:00',
            workEndTime: '01:00',
            workDays: 'السبت,الأحد,الإثنين,الثلاثاء,الأربعاء,الخميس,الجمعة',
            is_active: true,
            isOnLeave: false
        });

        // Employee 2 (Night Shift)
        await User.create({
            fullName: 'موظف ليلي',
            phone: '01000000002',
            username: 'sales_night',
            password: hashPass,
            role: 'sales',
            maxCustomers: 999999,
            workStartTime: '01:00',
            workEndTime: '09:00',
            workDays: 'السبت,الأحد,الإثنين,الثلاثاء,الأربعاء,الخميس,الجمعة',
            is_active: true,
            isOnLeave: false
        });

        console.log('Employees added successfully.');
        process.exit(0);
    } catch(e) {
        console.error(e);
        process.exit(1);
    }
})();
