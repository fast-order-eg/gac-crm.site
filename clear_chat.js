import { Sequelize } from 'sequelize';

const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: './database.sqlite',
  logging: false
});

async function clear() {
  try {
    await sequelize.query('DELETE FROM Messages');
    await sequelize.query('DELETE FROM Conversations');
    await sequelize.query('DELETE FROM Customers');
    console.log('All chats cleared successfully!');
  } catch(e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
}
clear();
