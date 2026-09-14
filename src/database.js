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

  // Pre-populate account slots if not present
  for (let i = 1; i <= config.accountsCount; i++) {
    const existing = await get(`SELECT account_id FROM accounts WHERE account_id = ?`, [i]);
    if (!existing) {
      await run(`INSERT INTO accounts (account_id, status) VALUES (?, 'disconnected')`, [i]);
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
};
