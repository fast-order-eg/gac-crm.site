import { Sequelize } from 'sequelize';
import User from './models/User.js';
import Conversation from './models/Conversation.js';
import sequelize from './config/database.js';

async function checkDB() {
    try {
        const users = await User.findAll({ attributes: ['id', 'username', 'role'] });
        console.log("Users in DB:");
        console.table(users.map(u => u.toJSON()));

        const convs = await Conversation.findAll({ attributes: ['id', 'UserId', 'remoteJid'], limit: 10 });
        console.log("Conversations sample:");
        console.table(convs.map(c => c.toJSON()));

        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}
checkDB();
