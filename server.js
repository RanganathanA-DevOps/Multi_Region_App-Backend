const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Pool } = require('pg');
const schedule = require('node-schedule');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// PostgreSQL connection
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
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

// Email configuration - Enhanced with better error handling
let emailTransporter;
try {
  emailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: process.env.SMTP_PORT || 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  console.log('Email transporter configured');
} catch (error) {
  console.error('Error configuring email transporter:', error);
  emailTransporter = null;
}

// Test database connection
pool.on('connect', () => {
  console.log('Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  console.error('PostgreSQL connection error:', err);
});

// Initialize database schema
async function initializeDatabase() {
  try {
    // Create tables if they don't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sites (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        url VARCHAR(500) NOT NULL,
        health_check_endpoint VARCHAR(500),
        alert_emails TEXT, -- Changed from alert_email to alert_emails
        expected_status INTEGER DEFAULT 200,
        expected_response_time INTEGER DEFAULT 5000,
        check_interval INTEGER DEFAULT 5, -- NEW: Check interval in minutes
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS check_history (
        id SERIAL PRIMARY KEY,
        site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
        status VARCHAR(50) NOT NULL,
        response_time INTEGER,
        status_code INTEGER,
        message TEXT,
        checked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS incidents (
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

    console.log('Database schema initialized successfully');
  } catch (error) {
    console.error('Error initializing database schema:', error);
  }
}

// Test email configuration on startup
async function testEmailConfig() {
  if (!emailTransporter) {
    console.log('Email transporter not configured - alerts will be disabled');
    return;
  }

  try {
    await emailTransporter.verify();
    console.log('Email transporter is ready');
  } catch (error) {
    console.error('Email configuration error:', error);
    console.log('Email alerts will be disabled due to configuration error');
  }
}

// Initialize app
async function initializeApp() {
  await initializeDatabase();
  await testEmailConfig();
}

initializeApp();

// ========== ADDED ROOT ROUTE ==========
app.get('/', (req, res) => {
  res.json({
    name: 'Site Monitor API',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      sites: '/api/sites',
      health: '/api/health',
      testEmail: '/api/test-email',
      reports: {
        uptime: '/api/reports/uptime',
        overview: '/api/reports/overview',
        incidents: '/api/reports/incidents'
      }
    },
    timestamp: new Date().toISOString()
  });
});

// ========== ADDED SIMPLE HEALTH CHECK ROUTE ==========
app.get('/health-check', (req, res) => {
  res.json({
    status: 'OK',
    service: 'Site Monitor Backend',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage()
  });
});

// Health check function
async function performHealthCheck(site) {
  const startTime = Date.now();
  try {
    const response = await axios.get(site.health_check_endpoint || site.url, {
      timeout: site.expected_response_time
    });
    
    const responseTime = Date.now() - startTime;
    const status = response.status === site.expected_status ? 'up' : 'degraded';
    
    return {
      status,
      responseTime,
      statusCode: response.status,
      message: status === 'up' ? 'Site is healthy' : `Unexpected status code: ${response.status}`
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    let message = 'Site is down';
    
    if (error.code === 'ECONNREFUSED') {
      message = 'Connection refused';
    } else if (error.code === 'ETIMEDOUT') {
      message = 'Request timeout';
    } else if (error.response) {
      message = `HTTP Error: ${error.response.status}`;
    } else {
      message = error.message;
    }
    
    return {
      status: 'down',
      responseTime,
      statusCode: error.response?.status || 0,
      message
    };
  }
}

// Helper function to parse email strings into array
function parseEmails(emailString) {
  if (!emailString) return [];
  
  return emailString
    .split(',')
    .map(email => email.trim())
    .filter(email => email.length > 0 && email.includes('@'));
}

// Email alert function - UPDATED for multiple emails
async function sendEmailAlert(site, incident, type = 'downtime') {
  const emailList = parseEmails(site.alert_emails);
  
  if (emailList.length === 0) {
    console.log(`No alert emails configured for site: ${site.name}`);
    return false;
  }

  if (!emailTransporter) {
    console.log(`Email transporter not available - cannot send alert for ${site.name}`);
    return false;
  }

  try {
    let subject, html;
    
    if (type === 'downtime') {
      subject = `🚨 Site Down Alert: ${site.name}`;
      html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #dc2626;">Site Down Alert</h2>
          <p><strong>Site Name:</strong> ${site.name}</p>
          <p><strong>URL:</strong> ${site.url}</p>
          <p><strong>Health Check Endpoint:</strong> ${site.health_check_endpoint || site.url}</p>
          <p><strong>Status:</strong> <span style="color: #dc2626; font-weight: bold;">DOWN</span></p>
          <p><strong>Downtime Started:</strong> ${new Date(incident.start_time).toLocaleString()}</p>
          <p><strong>Last Message:</strong> ${incident.message || 'Connection failed'}</p>
          <p><strong>Duration:</strong> ${incident.duration_minutes || 0} minutes</p>
          <hr>
          <p style="color: #6b7280; font-size: 0.9em;">
            This alert was triggered because the site has been down for more than 10 minutes.
            You will receive another email when the site recovers.
          </p>
        </div>
      `;
    } else if (type === 'recovery') {
      subject = `✅ Site Recovered: ${site.name}`;
      html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #059669;">Site Recovery Notification</h2>
          <p><strong>Site Name:</strong> ${site.name}</p>
          <p><strong>URL:</strong> ${site.url}</p>
          <p><strong>Health Check Endpoint:</strong> ${site.health_check_endpoint || site.url}</p>
          <p><strong>Status:</strong> <span style="color: #059669; font-weight: bold;">UP</span></p>
          <p><strong>Downtime Started:</strong> ${new Date(incident.start_time).toLocaleString()}</p>
          <p><strong>Recovery Time:</strong> ${new Date(incident.end_time).toLocaleString()}</p>
          <p><strong>Total Downtime Duration:</strong> ${incident.duration_minutes || 0} minutes</p>
          <hr>
          <p style="color: #6b7280; font-size: 0.9em;">
            The site has recovered and is now responding normally.
          </p>
        </div>
      `;
    }

    const mailOptions = {
      from: process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@sitemonitor.com',
      to: emailList.join(', '), // Send to all emails
      subject: subject,
      html: html
    };

    await emailTransporter.sendMail(mailOptions);
    console.log(`✅ Email alert sent for ${site.name} to ${emailList.length} recipients: ${emailList.join(', ')}`);
    return true;
  } catch (error) {
    console.error('❌ Error sending email alert:', error);
    return false;
  }
}

// Enhanced incident management with better email scheduling
async function trackIncident(site, healthResult) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // Check for existing ongoing incident
    const ongoingIncident = await client.query(
      `SELECT * FROM incidents 
       WHERE site_id = $1 AND end_time IS NULL 
       ORDER BY start_time DESC LIMIT 1`,
      [site.id]
    );

    if (healthResult.status === 'down' || healthResult.status === 'degraded') {
      // Site is down/degraded
      if (ongoingIncident.rows.length === 0) {
        // Start new incident
        const newIncident = await client.query(
          `INSERT INTO incidents (site_id, start_time, status, message) 
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [site.id, new Date(), healthResult.status, healthResult.message]
        );
        
        console.log(`🟡 New incident started for ${site.name}: ${healthResult.message}`);
        
        // Schedule email alert for 10 minutes from now
        const incidentId = newIncident.rows[0].id;
        setTimeout(async () => {
          try {
            const incidentCheck = await pool.query(
              `SELECT * FROM incidents WHERE id = $1 AND end_time IS NULL`,
              [incidentId]
            );
            
            if (incidentCheck.rows.length > 0 && !incidentCheck.rows[0].email_sent) {
              const incident = incidentCheck.rows[0];
              const durationMinutes = Math.floor((new Date() - new Date(incident.start_time)) / (1000 * 60));
              
              console.log(`⏰ Sending downtime email for ${site.name} after ${durationMinutes} minutes`);
              
              const emailSent = await sendEmailAlert(site, {
                ...incident,
                message: healthResult.message,
                duration_minutes: durationMinutes
              }, 'downtime');
              
              if (emailSent) {
                await pool.query(
                  `UPDATE incidents SET email_sent = true, email_sent_at = $1 WHERE id = $2`,
                  [new Date(), incidentId]
                );
              }
            }
          } catch (error) {
            console.error('Error in email timeout callback:', error);
          }
        }, 10 * 60 * 1000); // 10 minutes
        
      } else {
        // Update existing incident duration and message
        const incident = ongoingIncident.rows[0];
        const durationMinutes = Math.floor((new Date() - new Date(incident.start_time)) / (1000 * 60));
        
        await client.query(
          `UPDATE incidents SET duration_minutes = $1, message = $2 WHERE id = $3`,
          [durationMinutes, healthResult.message, incident.id]
        );
      }
      
    } else {
      // Site is up
      if (ongoingIncident.rows.length > 0) {
        const incident = ongoingIncident.rows[0];
        const endTime = new Date();
        const durationMinutes = Math.floor((endTime - new Date(incident.start_time)) / (1000 * 60));
        
        // End the incident
        await client.query(
          `UPDATE incidents SET end_time = $1, duration_minutes = $2 WHERE id = $3`,
          [endTime, durationMinutes, incident.id]
        );
        
        console.log(`🟢 Incident resolved for ${site.name} after ${durationMinutes} minutes`);
        
        // Send recovery email if downtime email was sent
        if (incident.email_sent && !incident.resolved_email_sent) {
          console.log(`⏰ Sending recovery email for ${site.name}`);
          
          const recoveryEmailSent = await sendEmailAlert(site, {
            ...incident,
            end_time: endTime,
            duration_minutes: durationMinutes
          }, 'recovery');
          
          if (recoveryEmailSent) {
            await client.query(
              `UPDATE incidents SET resolved_email_sent = true, resolved_email_sent_at = $1 WHERE id = $2`,
              [new Date(), incident.id]
            );
          }
        }
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error tracking incident:', error);
  } finally {
    client.release();
  }
}

// Automatic health check scheduler
async function performScheduledHealthChecks() {
  console.log('Running scheduled health checks...');
  try {
    const sites = await pool.query('SELECT * FROM sites WHERE is_active = true');
    
    for (const site of sites.rows) {
      try {
        const healthResult = await performHealthCheck(site);
        
        // Save to history
        await pool.query(
          `INSERT INTO check_history (site_id, status, response_time, status_code, message) 
           VALUES ($1, $2, $3, $4, $5)`,
          [
            site.id,
            healthResult.status,
            healthResult.responseTime,
            healthResult.statusCode,
            healthResult.message
          ]
        );
        
        // Track incidents and send alerts
        await trackIncident(site, healthResult);
        
        const statusIcon = healthResult.status === 'up' ? '🟢' : healthResult.status === 'degraded' ? '🟡' : '🔴';
        console.log(`${statusIcon} Checked ${site.name}: ${healthResult.status} (${healthResult.responseTime}ms)`);
      } catch (error) {
        console.error(`Error checking ${site.name}:`, error.message);
      }
    }
  } catch (error) {
    console.error('Error in scheduled health checks:', error);
  }
}

// Schedule health checks every 5 minutes
schedule.scheduleJob('*/5 * * * *', performScheduledHealthChecks);

// Run immediately on startup (after 5 seconds delay)
setTimeout(performScheduledHealthChecks, 5000);

// Routes

// Get all sites
app.get('/api/sites', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM sites WHERE is_active = true ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching sites:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get latest health status for all sites
app.get('/api/sites/health-status', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT ON (s.id) 
        s.*,
        ch.status as last_status,
        ch.response_time as last_response_time,
        ch.status_code as last_status_code,
        ch.message as last_message,
        ch.checked_at as last_checked
      FROM sites s
      LEFT JOIN check_history ch ON s.id = ch.site_id
      WHERE s.is_active = true
      ORDER BY s.id, ch.checked_at DESC
    `);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching health status:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get site by ID - NEW endpoint for editing
app.get('/api/sites/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM sites WHERE id = $1',
      [req.params.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Site not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching site:', error);
    res.status(500).json({ error: error.message });
  }
});

// Add new site to monitor - UPDATED for multiple emails and check interval
app.post('/api/sites', async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const { name, url, healthCheckEndpoint, alertEmails, expectedStatus, expectedResponseTime, checkInterval } = req.body;
    
    // Validate required fields
    if (!name || !url) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Name and URL are required fields' });
    }

    // Validate URL format
    try {
      new URL(url);
    } catch (error) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    // Process alert emails - convert array to comma-separated string for storage
    const alertEmailsString = Array.isArray(alertEmails) 
      ? alertEmails.join(', ') 
      : (alertEmails || '');

    const result = await client.query(
      `INSERT INTO sites (name, url, health_check_endpoint, alert_emails, expected_status, expected_response_time, check_interval) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) 
       RETURNING *`,
      [
        name, 
        url, 
        healthCheckEndpoint || url, 
        alertEmailsString,
        expectedStatus || 200, 
        expectedResponseTime || 5000,
        checkInterval || 5  // NEW: Default check interval of 5 minutes
      ]
    );
    
    await client.query('COMMIT');
    res.status(201).json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error adding site:', error);
    
    // Handle specific PostgreSQL errors
    if (error.code === '23505') { // Unique violation
      res.status(400).json({ error: 'A site with this name or URL already exists' });
    } else if (error.code === '42703') { // Column doesn't exist
      res.status(500).json({ error: 'Database schema issue. Please restart the server.' });
    } else {
      res.status(400).json({ error: error.message });
    }
  } finally {
    client.release();
  }
});

// Check single site health
app.get('/api/sites/:id/health', async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // Get site details
    const siteResult = await client.query(
      'SELECT * FROM sites WHERE id = $1 AND is_active = true',
      [req.params.id]
    );
    
    if (siteResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Site not found' });
    }
    
    const site = siteResult.rows[0];
    const healthResult = await performHealthCheck(site);
    
    // Save to history
    await client.query(
      `INSERT INTO check_history (site_id, status, response_time, status_code, message) 
       VALUES ($1, $2, $3, $4, $5)`,
      [
        site.id,
        healthResult.status,
        healthResult.responseTime,
        healthResult.statusCode,
        healthResult.message
      ]
    );

    // Track incidents
    await trackIncident(site, healthResult);
    
    await client.query('COMMIT');
    
    res.json({
      site: site,
      health: healthResult
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error checking site health:', error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Check all sites health
app.get('/api/health-check/all', async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // Get all active sites
    const sitesResult = await client.query(
      'SELECT * FROM sites WHERE is_active = true ORDER BY name'
    );
    
    const results = [];
    
    for (const site of sitesResult.rows) {
      const healthResult = await performHealthCheck(site);
      
      // Save to history
      await client.query(
        `INSERT INTO check_history (site_id, status, response_time, status_code, message) 
         VALUES ($1, $2, $3, $4, $5)`,
        [
          site.id,
          healthResult.status,
          healthResult.responseTime,
          healthResult.statusCode,
          healthResult.message
        ]
      );

      // Track incidents
      await trackIncident(site, healthResult);
      
      results.push({
        site: site,
        health: healthResult
      });
    }
    
    await client.query('COMMIT');
    res.json(results);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error checking all sites:', error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Get site monitoring history
app.get('/api/sites/:id/history', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM check_history 
       WHERE site_id = $1 
       ORDER BY checked_at DESC 
       LIMIT 50`,
      [req.params.id]
    );
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching site history:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update site - UPDATED for multiple emails and check interval
app.put('/api/sites/:id', async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const { name, url, healthCheckEndpoint, alertEmails, expectedStatus, expectedResponseTime, checkInterval, isActive } = req.body;
    
    // Validate required fields
    if (!name || !url) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Name and URL are required fields' });
    }

    // Process alert emails - convert array to comma-separated string for storage
    const alertEmailsString = Array.isArray(alertEmails) 
      ? alertEmails.join(', ') 
      : (alertEmails || '');

    const result = await client.query(
      `UPDATE sites 
       SET name = $1, url = $2, health_check_endpoint = $3, alert_emails = $4, expected_status = $5, 
           expected_response_time = $6, check_interval = $7, is_active = $8, updated_at = CURRENT_TIMESTAMP
       WHERE id = $9 
       RETURNING *`,
      [
        name, 
        url, 
        healthCheckEndpoint, 
        alertEmailsString,
        expectedStatus, 
        expectedResponseTime, 
        checkInterval || 5,  // NEW: Check interval with default
        isActive, 
        req.params.id
      ]
    );
    
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Site not found' });
    }
    
    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating site:', error);
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Delete site
app.delete('/api/sites/:id', async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // First delete related history records
    await client.query('DELETE FROM check_history WHERE site_id = $1', [req.params.id]);
    
    // Delete related incidents
    await client.query('DELETE FROM incidents WHERE site_id = $1', [req.params.id]);
    
    // Then delete the site
    const result = await client.query('DELETE FROM sites WHERE id = $1 RETURNING *', [req.params.id]);
    
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Site not found' });
    }
    
    await client.query('COMMIT');
    res.json({ message: 'Site deleted successfully', site: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error deleting site:', error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Get incidents for a site
app.get('/api/sites/:id/incidents', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM incidents 
       WHERE site_id = $1 
       ORDER BY start_time DESC 
       LIMIT 50`,
      [req.params.id]
    );
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching incidents:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all incidents
app.get('/api/incidents', async (req, res) => {
  try {
    const { period = '7d' } = req.query;
    
    let interval;
    switch (period) {
      case '24h':
        interval = "24 hours";
        break;
      case '7d':
        interval = "7 days";
        break;
      case '30d':
        interval = "30 days";
        break;
      default:
        interval = "7 days";
    }

    const result = await pool.query(`
      SELECT 
        i.*,
        s.name as site_name,
        s.url as site_url,
        s.alert_emails
      FROM incidents i
      JOIN sites s ON i.site_id = s.id
      WHERE i.start_time >= NOW() - INTERVAL '${interval}'
      ORDER BY i.start_time DESC
    `);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching incidents:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get uptime report
app.get('/api/reports/uptime', async (req, res) => {
  try {
    const { period = '24h' } = req.query;
    
    let interval;
    switch (period) {
      case '1h':
        interval = "1 hour";
        break;
      case '24h':
        interval = "24 hours";
        break;
      case '7d':
        interval = "7 days";
        break;
      case '30d':
        interval = "30 days";
        break;
      default:
        interval = "24 hours";
    }

    const result = await pool.query(`
      SELECT 
        s.id,
        s.name,
        s.url,
        s.alert_emails,
        COUNT(ch.id) as total_checks,
        COUNT(CASE WHEN ch.status = 'up' THEN 1 END) as successful_checks,
        ROUND(
          (COUNT(CASE WHEN ch.status = 'up' THEN 1 END) * 100.0 / NULLIF(COUNT(ch.id), 0)
        ), 2) as uptime_percentage,
        ROUND(AVG(ch.response_time)) as avg_response_time,
        MAX(ch.checked_at) as last_check
      FROM sites s
      LEFT JOIN check_history ch ON s.id = ch.site_id 
        AND ch.checked_at >= NOW() - INTERVAL '${interval}'
      WHERE s.is_active = true
      GROUP BY s.id, s.name, s.url, s.alert_emails
      ORDER BY uptime_percentage DESC
    `);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching uptime report:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get overview report
app.get('/api/reports/overview', async (req, res) => {
  try {
    const { period = '24h' } = req.query;
    
    let interval;
    switch (period) {
      case '1h':
        interval = "1 hour";
        break;
      case '24h':
        interval = "24 hours";
        break;
      case '7d':
        interval = "7 days";
        break;
      case '30d':
        interval = "30 days";
        break;
      default:
        interval = "24 hours";
    }

    // Overall statistics
    const overallStats = await pool.query(`
      SELECT 
        COUNT(DISTINCT s.id) as total_monitored_sites,
        COUNT(ch.id) as total_checks,
        ROUND(AVG(ch.response_time)) as avg_response_time,
        ROUND(
          (COUNT(CASE WHEN ch.status = 'up' THEN 1 END) * 100.0 / NULLIF(COUNT(ch.id), 0)
        ), 2) as overall_uptime_percentage
      FROM sites s
      LEFT JOIN check_history ch ON s.id = ch.site_id 
        AND ch.checked_at >= NOW() - INTERVAL '${interval}'
      WHERE s.is_active = true
    `);

    // Status distribution
    const statusDistribution = await pool.query(`
      SELECT 
        status,
        COUNT(*) as count
      FROM check_history
      WHERE checked_at >= NOW() - INTERVAL '${interval}'
      GROUP BY status
      ORDER BY count DESC
    `);

    // Top slowest sites
    const topSlowestSites = await pool.query(`
      SELECT 
        s.name,
        ROUND(AVG(ch.response_time)) as avg_response_time
      FROM sites s
      JOIN check_history ch ON s.id = ch.site_id 
        AND ch.checked_at >= NOW() - INTERVAL '${interval}'
      WHERE s.is_active = true
      GROUP BY s.id, s.name
      ORDER BY avg_response_time DESC
      LIMIT 5
    `);

    res.json({
      overall: overallStats.rows[0],
      statusDistribution: statusDistribution.rows,
      topSlowestSites: topSlowestSites.rows
    });
  } catch (error) {
    console.error('Error fetching overview report:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get incidents report
app.get('/api/reports/incidents', async (req, res) => {
  try {
    const { period = '24h' } = req.query;
    
    let interval;
    switch (period) {
      case '1h':
        interval = "1 hour";
        break;
      case '24h':
        interval = "24 hours";
        break;
      case '7d':
        interval = "7 days";
        break;
      case '30d':
        interval = "30 days";
        break;
      default:
        interval = "24 hours";
    }

    const result = await pool.query(`
      SELECT 
        i.*,
        s.name as site_name,
        s.url as site_url,
        s.alert_emails
      FROM incidents i
      JOIN sites s ON i.site_id = s.id
      WHERE i.start_time >= NOW() - INTERVAL '${interval}'
        AND s.is_active = true
      ORDER BY i.start_time DESC
      LIMIT 50
    `);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching incidents report:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check endpoint for the monitoring app itself
app.get('/api/health', async (req, res) => {
  try {
    // Test database connection
    await pool.query('SELECT 1');
    
    const emailStatus = emailTransporter ? 'configured' : 'not configured';
    
    res.json({ 
      status: 'healthy', 
      database: 'connected',
      email: emailStatus,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'unhealthy', 
      database: 'disconnected',
      error: error.message 
    });
  }
});

// Test email endpoint - UPDATED for multiple emails
app.post('/api/test-email', async (req, res) => {
  const { emails } = req.body;
  
  if (!emails) {
    return res.status(400).json({ error: 'Email addresses are required' });
  }

  if (!emailTransporter) {
    return res.status(500).json({ error: 'Email transporter not configured' });
  }

  try {
    const emailList = parseEmails(emails);
    
    if (emailList.length === 0) {
      return res.status(400).json({ error: 'No valid email addresses provided' });
    }

    const mailOptions = {
      from: process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@sitemonitor.com',
      to: emailList.join(', '),
      subject: 'Test Email from Site Monitor',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #059669;">Test Email</h2>
          <p>This is a test email from your Site Monitoring application.</p>
          <p>If you received this email, your SMTP configuration is working correctly.</p>
          <p><strong>Timestamp:</strong> ${new Date().toLocaleString()}</p>
          <p><strong>Sent to:</strong> ${emailList.join(', ')}</p>
        </div>
      `
    };

    await emailTransporter.sendMail(mailOptions);
    res.json({ message: `Test email sent successfully to ${emailList.length} recipients` });
  } catch (error) {
    console.error('Error sending test email:', error);
    res.status(500).json({ error: 'Failed to send test email: ' + error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Automatic health checks scheduled every 5 minutes');
  console.log(`- Root endpoint: http://localhost:${PORT}/`);
  console.log(`- Health check: http://localhost:${PORT}/health-check`);
  console.log(`- API health: http://localhost:${PORT}/api/health`);
  
  if (emailTransporter) {
    console.log('✅ Email alerts enabled for sites with configured email addresses');
  } else {
    console.log('❌ Email alerts disabled - check SMTP configuration');
  }
});