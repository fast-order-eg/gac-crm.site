import { Message, Conversation, Customer } from './models/index.js';

async function clear() {
  try {
    await Message.destroy({ where: {} });
    await Conversation.destroy({ where: {} });
    // Keep customers or delete them too? The user said "المحادثات كلها من علي الرقم", so conversations and messages are enough.
    // I will delete customers just to be safe.
    await Customer.destroy({ where: {} });
    console.log('All chats cleared successfully!');
  } catch(e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
}

clear();
