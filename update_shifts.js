import { Sequelize, Op } from 'sequelize';
import User from './models/User.js';

async function updateShifts() {
  try {
    // 1. Clear Admin working hours
    await User.update({
      workStartTime: null,
      workEndTime: null,
      workDays: null
    }, {
      where: {
        role: {
          [Op.in]: ['admin', 'super_admin']
        }
      }
    });
    console.log('Admin shifts cleared.');

    // 2. Update Sales working hours
    const salesUsers = await User.findAll({
      where: {
        role: 'sales'
      },
      order: [['id', 'ASC']]
    });

    if (salesUsers.length === 3) {
      const allDays = 'السبت,الأحد,الإثنين,الثلاثاء,الأربعاء,الخميس,الجمعة';

      await salesUsers[0].update({ workStartTime: '00:00', workEndTime: '08:00', workDays: allDays });
      await salesUsers[1].update({ workStartTime: '08:00', workEndTime: '16:00', workDays: allDays });
      await salesUsers[2].update({ workStartTime: '16:00', workEndTime: '23:59', workDays: allDays });
      console.log('Sales shifts updated to cover 24/7.');
    } else if (salesUsers.length > 0) {
      console.log(`Found ${salesUsers.length} sales users instead of 3. Distributing among available users...`);
      const allDays = 'السبت,الأحد,الإثنين,الثلاثاء,الأربعاء,الخميس,الجمعة';
      if (salesUsers.length >= 3) {
          await salesUsers[0].update({ workStartTime: '00:00', workEndTime: '08:00', workDays: allDays });
          await salesUsers[1].update({ workStartTime: '08:00', workEndTime: '16:00', workDays: allDays });
          await salesUsers[2].update({ workStartTime: '16:00', workEndTime: '23:59', workDays: allDays });
      } else {
          // If less than 3, just give them some shifts to avoid errors
          await salesUsers[0].update({ workStartTime: '00:00', workEndTime: '12:00', workDays: allDays });
          if(salesUsers[1]) await salesUsers[1].update({ workStartTime: '12:00', workEndTime: '23:59', workDays: allDays });
      }
      console.log('Sales shifts updated.');
    } else {
        console.log("No sales users found.");
    }
    
    process.exit(0);

  } catch (error) {
    console.error('Error updating shifts:', error);
    process.exit(1);
  }
}

updateShifts();
