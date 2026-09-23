import Customer from './models/Customer.js';

async function clear() {
  try {
    await Customer.destroy({ where: {} });
    console.log('All customers cleared successfully!');
  } catch(e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
}

clear();
