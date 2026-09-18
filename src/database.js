const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const config = require('./config');

// Ensure data directory exists
if (!fs.existsSync(config.dataDir)) {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

const db = new sqlite3.Database(config.dbPath, (err) => {
  if (err) {
    console.error('Failed to connect to SQLite database:', err.message);
  } else {
    console.log('Connected to local SQLite database at:', config.dbPath);
  }
});

// Run a query wrapped in a Promise
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

// Get all rows
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Get single row
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

// Initialize tables
async function init() {
  await run(`
    CREATE TABLE IF NOT EXISTS accounts (
      account_id INTEGER PRIMARY KEY,
      phone_number TEXT,
      name TEXT,
      status TEXT DEFAULT 'disconnected',
      last_connected_at DATETIME
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS leads (
      phone_number TEXT PRIMARY KEY,
      name TEXT,
      account_id INTEGER,
      first_contact_at DATETIME,
      last_contact_at DATETIME,
      total_messages INTEGER DEFAULT 1,
      notes TEXT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER,
      lead_phone TEXT,
      lead_name TEXT,
      from_me INTEGER DEFAULT 0,
      body TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Prevent duplicate messages during history sync
  await run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_unique 
    ON messages (account_id, lead_phone, timestamp, from_me, body)
  `);

  // Campaigns table
  await run(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      template TEXT NOT NULL,
      status TEXT DEFAULT 'draft',
      total_contacts INTEGER DEFAULT 0,
      sent_count INTEGER DEFAULT 0,
      failed_count INTEGER DEFAULT 0,
      min_delay INTEGER DEFAULT 6,
      max_delay INTEGER DEFAULT 12,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Campaign items (each recipient assigned to a specific account)
  await run(`
    CREATE TABLE IF NOT EXISTS campaign_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      account_id INTEGER NOT NULL,
      phone_number TEXT NOT NULL,
      name TEXT,
      personalized_text TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      error TEXT,
      sent_at DATETIME,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE INDEX IF NOT EXISTS idx_campaign_items_lookup
    ON campaign_items (campaign_id, account_id, status)
  `);

  // Notification logs (tracks all alerts dispatched to main phone)
  await run(`
    CREATE TABLE IF NOT EXISTS notification_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER,
      sender_phone TEXT,
      sender_name TEXT,
      message_text TEXT,
      status TEXT DEFAULT 'sent',
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Dedicated daily outreach leads per connected number
  await run(`
    CREATE TABLE IF NOT EXISTS outreach_leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      phone_number TEXT NOT NULL,
      name TEXT,
      status TEXT DEFAULT 'pending',
      scheduled_at DATETIME,
      sent_at DATETIME,
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE INDEX IF NOT EXISTS idx_outreach_leads_queue
    ON outreach_leads (account_id, status, id ASC)
  `);

  // Per-account outreach scheduler state & delay configuration
  await run(`
    CREATE TABLE IF NOT EXISTS outreach_accounts (
      account_id INTEGER PRIMARY KEY,
      is_active INTEGER DEFAULT 1,
      min_delay_minutes INTEGER DEFAULT 10,
      max_delay_minutes INTEGER DEFAULT 15,
      next_run_at DATETIME,
      last_sent_at DATETIME,
      custom_template TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Pre-populate account slots and outreach state slots
  for (let i = 1; i <= config.accountsCount; i++) {
    const existing = await get(`SELECT account_id FROM accounts WHERE account_id = ?`, [i]);
    if (!existing) {
      await run(`INSERT INTO accounts (account_id, status) VALUES (?, 'disconnected')`, [i]);
    }

    const existingOutreach = await get(`SELECT account_id FROM outreach_accounts WHERE account_id = ?`, [i]);
    if (!existingOutreach) {
      await run(
        `INSERT INTO outreach_accounts (account_id, is_active, min_delay_minutes, max_delay_minutes) VALUES (?, 1, 10, 15)`,
        [i]
      );
    }
  }
}

async function updateAccount(accountId, updates) {
  const fields = [];
  const values = [];
  for (const [key, value] of Object.entries(updates)) {
    fields.push(`${key} = ?`);
    values.push(value);
  }
  values.push(accountId);
  await run(`UPDATE accounts SET ${fields.join(', ')} WHERE account_id = ?`, values);
}

async function getAccounts() {
  return all(`SELECT * FROM accounts ORDER BY account_id ASC`);
}

async function recordMessage({ accountId, leadPhone, leadName, fromMe, body, timestamp }) {
  const now = timestamp ? new Date(timestamp).toISOString() : new Date().toISOString();

  // 1. Insert message
  const result = await run(
    `INSERT OR IGNORE INTO messages (account_id, lead_phone, lead_name, from_me, body, timestamp) VALUES (?, ?, ?, ?, ?, ?)`,
    [accountId, leadPhone, leadName || null, fromMe ? 1 : 0, body || '', now]
  );

  // 2. Upsert lead
  const existingLead = await get(`SELECT * FROM leads WHERE phone_number = ?`, [leadPhone]);
  if (!existingLead) {
    await run(
      `INSERT INTO leads (phone_number, name, account_id, first_contact_at, last_contact_at, total_messages) VALUES (?, ?, ?, ?, ?, 1)`,
      [leadPhone, leadName || null, accountId, now, now]
    );
  } else {
    await run(
      `UPDATE leads SET 
        last_contact_at = ?,
        total_messages = total_messages + 1,
        name = COALESCE(?, name),
        account_id = ?
       WHERE phone_number = ?`,
      [now, leadName || null, accountId, leadPhone]
    );
  }

  return {
    id: result.lastID,
    account_id: accountId,
    lead_phone: leadPhone,
    lead_name: leadName || null,
    from_me: fromMe ? 1 : 0,
    body: body || '',
    timestamp: now,
  };
}

/**
 * Fast bulk insert for WhatsApp history sync
 */
async function recordBatchMessages(messagesList) {
  if (!messagesList || messagesList.length === 0) return 0;

  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');

      const stmtMsg = db.prepare(
        `INSERT OR IGNORE INTO messages (account_id, lead_phone, lead_name, from_me, body, timestamp) VALUES (?, ?, ?, ?, ?, ?)`
      );

      const stmtLead = db.prepare(
        `INSERT INTO leads (phone_number, name, account_id, first_contact_at, last_contact_at, total_messages)
         VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT(phone_number) DO UPDATE SET
           last_contact_at = MAX(last_contact_at, excluded.last_contact_at),
           first_contact_at = MIN(first_contact_at, excluded.first_contact_at),
           name = COALESCE(excluded.name, leads.name),
           total_messages = leads.total_messages + 1`
      );

      for (const m of messagesList) {
        stmtMsg.run([m.accountId, m.leadPhone, m.leadName || null, m.fromMe ? 1 : 0, m.body || '', m.timestamp]);
        stmtLead.run([m.leadPhone, m.leadName || null, m.accountId, m.timestamp, m.timestamp]);
      }

      stmtMsg.finalize();
      stmtLead.finalize();

      db.run('COMMIT', (err) => {
        if (err) reject(err);
        else resolve(messagesList.length);
      });
    });
  });
}

/**
 * Upsert contacts (names & phone numbers) from history sync
 */
async function updateContacts(contactsList) {
  if (!contactsList || contactsList.length === 0) return;

  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      const stmt = db.prepare(
        `INSERT INTO leads (phone_number, name, account_id, first_contact_at, last_contact_at, total_messages)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0)
         ON CONFLICT(phone_number) DO UPDATE SET
           name = COALESCE(excluded.name, leads.name)`
      );

      for (const c of contactsList) {
        if (c.phone && c.name) {
          stmt.run([c.phone, c.name, c.accountId]);
        }
      }

      stmt.finalize();
      db.run('COMMIT', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

/**
 * Get distinct chat conversations for an account, sorted by recent activity
 */
async function getChatsForAccount(accountId) {
  return all(
    `SELECT 
       m.lead_phone,
       COALESCE(l.name, m.lead_name, '') as name,
       m.body as last_message,
       m.timestamp as last_message_at,
       m.from_me as last_from_me
     FROM messages m
     LEFT JOIN leads l ON l.phone_number = m.lead_phone
     WHERE m.account_id = ? AND m.id IN (
       SELECT MAX(id) FROM messages WHERE account_id = ? GROUP BY lead_phone
     )
     ORDER BY m.timestamp DESC`,
    [accountId, accountId]
  );
}

/**
 * Get chronological chat message history between an account and a lead
 */
async function getChatMessages(accountId, leadPhone, limit = 200) {
  return all(
    `SELECT * FROM messages 
     WHERE account_id = ? AND lead_phone = ? 
     ORDER BY timestamp ASC 
     LIMIT ?`,
    [accountId, leadPhone, limit]
  );
}

async function getRecentMessages(limit = 50) {
  return all(`SELECT * FROM messages ORDER BY id DESC LIMIT ?`, [limit]);
}

async function getLeads(limit = 100) {
  return all(`SELECT * FROM leads ORDER BY last_contact_at DESC LIMIT ?`, [limit]);
}

async function getStats() {
  const totalLeads = await get(`SELECT COUNT(*) as count FROM leads`);
  const totalMessages = await get(`SELECT COUNT(*) as count FROM messages`);
  const incomingMessages = await get(`SELECT COUNT(*) as count FROM messages WHERE from_me = 0`);
  return {
    totalLeads: totalLeads?.count || 0,
    totalMessages: totalMessages?.count || 0,
    incomingMessages: incomingMessages?.count || 0,
  };
}

/**
 * Campaigns Database Methods
 */
async function createCampaign({ name, template, minDelay = 6, maxDelay = 12, items = [] }) {
  const result = await run(
    `INSERT INTO campaigns (name, template, status, total_contacts, min_delay, max_delay) VALUES (?, ?, 'draft', ?, ?, ?)`,
    [name || `Campaign ${new Date().toLocaleDateString()}`, template, items.length, minDelay, maxDelay]
  );
  const campaignId = result.lastID;

  if (items.length > 0) {
    await new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        const stmt = db.prepare(
          `INSERT INTO campaign_items (campaign_id, account_id, phone_number, name, personalized_text, status) VALUES (?, ?, ?, ?, ?, 'pending')`
        );
        for (const item of items) {
          stmt.run([
            campaignId,
            item.accountId,
            item.phone,
            item.name || null,
            item.personalizedText || '',
          ]);
        }
        stmt.finalize();
        db.run('COMMIT', (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });
  }

  return getCampaign(campaignId);
}

async function getCampaign(campaignId) {
  const campaign = await get(`SELECT * FROM campaigns WHERE id = ?`, [campaignId]);
  if (!campaign) return null;

  const itemCounts = await all(
    `SELECT account_id, status, COUNT(*) as count FROM campaign_items WHERE campaign_id = ? GROUP BY account_id, status`,
    [campaignId]
  );

  const accountBreakdown = {};
  for (const row of itemCounts) {
    if (!accountBreakdown[row.account_id]) {
      accountBreakdown[row.account_id] = { total: 0, sent: 0, failed: 0, pending: 0 };
    }
    accountBreakdown[row.account_id].total += row.count;
    if (row.status === 'sent') accountBreakdown[row.account_id].sent += row.count;
    else if (row.status === 'failed') accountBreakdown[row.account_id].failed += row.count;
    else accountBreakdown[row.account_id].pending += row.count;
  }

  return {
    ...campaign,
    accountBreakdown,
  };
}

async function getAllCampaigns() {
  return all(`SELECT * FROM campaigns ORDER BY id DESC`);
}

async function updateCampaignStatus(campaignId, status, extraUpdates = {}) {
  const fields = ['status = ?', 'updated_at = CURRENT_TIMESTAMP'];
  const values = [status];

  for (const [key, val] of Object.entries(extraUpdates)) {
    fields.push(`${key} = ?`);
    values.push(val);
  }
  values.push(campaignId);

  await run(`UPDATE campaigns SET ${fields.join(', ')} WHERE id = ?`, values);
}

async function getCampaignItems(campaignId, accountId = null) {
  if (accountId) {
    return all(`SELECT * FROM campaign_items WHERE campaign_id = ? AND account_id = ? ORDER BY id ASC`, [
      campaignId,
      accountId,
    ]);
  }
  return all(`SELECT * FROM campaign_items WHERE campaign_id = ? ORDER BY id ASC`, [campaignId]);
}

async function getPendingCampaignItemsForAccount(campaignId, accountId) {
  return all(
    `SELECT * FROM campaign_items WHERE campaign_id = ? AND account_id = ? AND status = 'pending' ORDER BY id ASC`,
    [campaignId, accountId]
  );
}

async function updateCampaignItem(itemId, { status, error, sent_at }) {
  const fields = ['status = ?'];
  const values = [status];

  if (error !== undefined) {
    fields.push('error = ?');
    values.push(error);
  }
  if (sent_at !== undefined) {
    fields.push('sent_at = ?');
    values.push(sent_at);
  }
  values.push(itemId);

  await run(`UPDATE campaign_items SET ${fields.join(', ')} WHERE id = ?`, values);
}

/**
 * Notifications Logging Methods
 */
async function logNotification({ accountId, senderPhone, senderName, messageText, status = 'sent', error = null }) {
  return run(
    `INSERT INTO notification_logs (account_id, sender_phone, sender_name, message_text, status, error) VALUES (?, ?, ?, ?, ?, ?)`,
    [accountId, senderPhone, senderName || null, messageText || '', status, error]
  );
}

async function getRecentNotifications(limit = 50) {
  return all(`SELECT * FROM notification_logs ORDER BY id DESC LIMIT ?`, [limit]);
}

/**
 * ============================================================================
 * Dedicated Per-Account Outreach Methods
 * ============================================================================
 */

async function addOutreachLeads(accountId, leadsList) {
  if (!leadsList || leadsList.length === 0) return 0;

  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');

      const stmt = db.prepare(
        `INSERT INTO outreach_leads (account_id, phone_number, name, status) VALUES (?, ?, ?, 'pending')`
      );

      for (const lead of leadsList) {
        stmt.run([accountId, lead.phone, lead.name || null]);
      }

      stmt.finalize();
      db.run('COMMIT', (err) => {
        if (err) reject(err);
        else resolve(leadsList.length);
      });
    });
  });
}

async function getNextPendingOutreachLead(accountId) {
  return get(
    `SELECT * FROM outreach_leads WHERE account_id = ? AND status = 'pending' ORDER BY id ASC LIMIT 1`,
    [accountId]
  );
}

async function updateOutreachLead(leadId, updates) {
  const fields = [];
  const values = [];

  for (const [key, val] of Object.entries(updates)) {
    fields.push(`${key} = ?`);
    values.push(val);
  }
  values.push(leadId);

  await run(`UPDATE outreach_leads SET ${fields.join(', ')} WHERE id = ?`, values);
}

async function getOutreachAccountState(accountId) {
  const state = await get(`SELECT * FROM outreach_accounts WHERE account_id = ?`, [accountId]);
  if (!state) {
    await run(
      `INSERT OR IGNORE INTO outreach_accounts (account_id, is_active, min_delay_minutes, max_delay_minutes) VALUES (?, 1, 10, 15)`,
      [accountId]
    );
    return get(`SELECT * FROM outreach_accounts WHERE account_id = ?`, [accountId]);
  }
  return state;
}

async function updateOutreachAccountState(accountId, updates) {
  const fields = ['updated_at = CURRENT_TIMESTAMP'];
  const values = [];

  for (const [key, val] of Object.entries(updates)) {
    fields.push(`${key} = ?`);
    values.push(val);
  }
  values.push(accountId);

  await run(`UPDATE outreach_accounts SET ${fields.join(', ')} WHERE account_id = ?`, values);
}

async function getOutreachQueueSummary(accountId) {
  const counts = await get(
    `SELECT 
       COUNT(*) as total,
       COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) as pending,
       COALESCE(SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END), 0) as sent,
       COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed
     FROM outreach_leads 
     WHERE account_id = ?`,
    [accountId]
  );

  return {
    total: counts?.total || 0,
    pending: counts?.pending || 0,
    sent: counts?.sent || 0,
    failed: counts?.failed || 0,
  };
}

async function getOutreachLeads(accountId, limit = 100, status = null) {
  if (status) {
    return all(
      `SELECT * FROM outreach_leads WHERE account_id = ? AND status = ? ORDER BY id ASC LIMIT ?`,
      [accountId, status, limit]
    );
  }
  return all(
    `SELECT * FROM outreach_leads WHERE account_id = ? ORDER BY id ASC LIMIT ?`,
    [accountId, limit]
  );
}

async function clearPendingOutreachLeads(accountId) {
  const result = await run(
    `DELETE FROM outreach_leads WHERE account_id = ? AND status = 'pending'`,
    [accountId]
  );
  return result.changes;
}

async function deleteOutreachLead(leadId) {
  const result = await run(`DELETE FROM outreach_leads WHERE id = ?`, [leadId]);
  return result.changes;
}

module.exports = {
  init,
  updateAccount,
  getAccounts,
  recordMessage,
  recordBatchMessages,
  updateContacts,
  getChatsForAccount,
  getChatMessages,
  getRecentMessages,
  getLeads,
  getStats,
  createCampaign,
  getCampaign,
  getAllCampaigns,
  updateCampaignStatus,
  getCampaignItems,
  getPendingCampaignItemsForAccount,
  updateCampaignItem,
  logNotification,
  getRecentNotifications,
  addOutreachLeads,
  getNextPendingOutreachLead,
  updateOutreachLead,
  getOutreachAccountState,
  updateOutreachAccountState,
  getOutreachQueueSummary,
  getOutreachLeads,
  clearPendingOutreachLeads,
  deleteOutreachLead,
};
