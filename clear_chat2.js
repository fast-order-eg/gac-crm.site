import { Sequelize } from 'sequelize';

const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: './database.sqlite',
  logging: false
});

async function run() {
  const [results] = await sequelize.query("SELECT name FROM sqlite_master WHERE type='table';");
  console.log(results.map(r => r.name));
  process.exit(0);
}

run();
