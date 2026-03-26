const { Pool } = require('pg');
require('dotenv').config();

// Azure PostgreSQL requires SSL and specific connection settings
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT || 5432,
  ssl: process.env.DB_SSL === 'true' ? {
    rejectUnauthorized: false // Required for Azure PostgreSQL
  } : false,
  connectionTimeoutMillis: 10000,
  // Azure specific settings
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

async function initializeDatabase() {
  let client;
  try {
    console.log('Connecting to Azure PostgreSQL...');
    console.log('Host:', process.env.DB_HOST);
    console.log('Database:', process.env.DB_NAME);
    console.log('User:', process.env.DB_USER);

    client = await pool.connect();
    console.log('✓ Connected to Azure PostgreSQL database');

    // Drop tables if they exist (for clean start)
    console.log('Dropping existing tables...');
    await client.query('DROP TABLE IF EXISTS check_history CASCADE');
    await client.query('DROP TABLE IF EXISTS incidents CASCADE');
    await client.query('DROP TABLE IF EXISTS sites CASCADE');

    // Create sites table with Azure-friendly data types
    await client.query(`
      CREATE TABLE sites (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        url VARCHAR(500) NOT NULL,
        health_check_endpoint VARCHAR(500),
        alert_emails TEXT,
        expected_status INTEGER DEFAULT 200,
        expected_response_time INTEGER DEFAULT 5000,
        check_interval INTEGER DEFAULT 5,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✓ Sites table created');

    // Create check_history table
    await client.query(`
      CREATE TABLE check_history (
        id SERIAL PRIMARY KEY,
        site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
        status VARCHAR(50) NOT NULL,
        response_time INTEGER,
        status_code INTEGER,
        message TEXT,
        checked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✓ Check_history table created');

    // Create incidents table
    await client.query(`
      CREATE TABLE incidents (
        id SERIAL PRIMARY KEY,
        site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
        start_time TIMESTAMP NOT NULL,
        end_time TIMESTAMP,
        status VARCHAR(50) NOT NULL,
        duration_minutes INTEGER DEFAULT 0,
        message TEXT,
        email_sent BOOLEAN DEFAULT false,
        email_sent_at TIMESTAMP,
        resolved_email_sent BOOLEAN DEFAULT false,
        resolved_email_sent_at TIMESTAMP
      )
    `);
    console.log('✓ Incidents table created');

    // Create indexes for better performance
    await client.query(`CREATE INDEX IF NOT EXISTS idx_check_history_site_id ON check_history(site_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_check_history_checked_at ON check_history(checked_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sites_is_active ON sites(is_active)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_incidents_site_id ON incidents(site_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_incidents_start_time ON incidents(start_time)`);
    console.log('✓ Indexes created');

    // Insert sample data
    console.log('Inserting sample data...');
    await client.query(`
      INSERT INTO sites (name, url, health_check_endpoint, alert_emails, expected_status, expected_response_time, check_interval) 
      VALUES 
        ('Google', 'https://www.google.com', 'https://www.google.com', 'admin@example.com, alerts@example.com', 200, 3000, 5),
        ('GitHub', 'https://www.github.com', 'https://www.github.com/health', 'admin@example.com, dev@example.com, team@example.com', 200, 5000, 10),
        ('JSONPlaceholder', 'https://jsonplaceholder.typicode.com', 'https://jsonplaceholder.typicode.com/posts', 'admin@example.com', 200, 3000, 5)
    `);
    console.log('✓ Sample data inserted');

    // Verify the table structure
    console.log('\n=== VERIFYING TABLE STRUCTURE ===');
    
    const sitesColumns = await client.query(`
      SELECT column_name, data_type, is_nullable 
      FROM information_schema.columns 
      WHERE table_name = 'sites' 
      ORDER BY ordinal_position
    `);
    console.log('Sites table columns:');
    sitesColumns.rows.forEach(col => {
      console.log(`  - ${col.column_name} (${col.data_type}, nullable: ${col.is_nullable})`);
    });

    console.log('\n✅ Database initialized successfully on Azure PostgreSQL!');
    console.log('You can now start your server with: node server.js');
    
  } catch (error) {
    console.error('❌ Error initializing database:', error);
    console.error('\nTroubleshooting tips for Azure PostgreSQL:');
    console.error('1. Verify your server name is correct: your-server.postgres.database.azure.com');
    console.error('2. Check if username includes @server: azadmin@your-server');
    console.error('3. Ensure firewall rules allow your IP address in Azure Portal');
    console.error('4. Verify SSL is enabled (Azure requires SSL connections)');
    console.error('5. Check if database "proddb" exists on the server');
    process.exit(1);
  } finally {
    if (client) {
      client.release();
    }
    await pool.end();
  }
}

// Run initialization
initializeDatabase();