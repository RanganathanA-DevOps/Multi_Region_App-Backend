const { Pool } = require('pg');
require('dotenv').config();

console.log('Testing Azure PostgreSQL connection...');
console.log('Host:', process.env.DB_HOST);
console.log('User:', process.env.DB_USER);
console.log('Database:', process.env.DB_NAME);
console.log('SSL:', process.env.DB_SSL);

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: parseInt(process.env.DB_PORT) || 5432,
  ssl: process.env.DB_SSL === 'true' ? {
    rejectUnauthorized: false
  } : false,
  connectionTimeoutMillis: 10000,
});

async function testConnection() {
  let client;
  try {
    client = await pool.connect();
    console.log('\n✅ SUCCESS! Connected to Azure PostgreSQL');
    
    const result = await client.query('SELECT version() as version, current_database() as db, current_user as user');
    console.log('\nDatabase Info:');
    console.log('- Version:', result.rows[0].version.split(',')[0]);
    console.log('- Database:', result.rows[0].db);
    console.log('- User:', result.rows[0].user);
    
    client.release();
  } catch (error) {
    console.error('\n❌ Connection failed:', error.message);
    console.error('\nTroubleshooting:');
    console.error('1. Username must be: azadmin@betteruptimepssql (with @server suffix)');
    console.error('2. Your IP (106.51.170.234) must be added to firewall rules');
    console.error('3. Password must be correct');
    console.error('4. Database "proddb" must exist');
  } finally {
    await pool.end();
  }
}

testConnection();