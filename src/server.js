const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');

// Crash protection for WebSocket blips & unhandled Baileys errors
process.on('uncaughtException', (err) => {
  console.error('⚠️ [SafeGuard] Handled uncaught exception:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('⚠️ [SafeGuard] Handled unhandled rejection:', reason?.message || reason);
});

const config = require('./config');
const database = require('./database');
const WhatsAppManager = require('./whatsappManager');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const waManager = new WhatsAppManager();

// GET /api/accounts - List all accounts with status and QR codes
app.get('/api/accounts', (req, res) => {
  res.json({
    mainPhoneNumber: config.mainPhoneNumber,
    notificationStyle: config.notificationStyle,
    debounceSeconds: config.debounceSeconds,
    accounts: waManager.getAccountStates(),
  });
});

// POST /api/accounts/:id/logout - Disconnect and clear session for an account
app.post('/api/accounts/:id/logout', async (req, res) => {
  const accountId = parseInt(req.params.id, 10);
  if (accountId < 1 || accountId > config.accountsCount) {
    return res.status(400).json({ error: 'Invalid account ID' });
  }

  await waManager.logoutAccount(accountId);
  res.json({ success: true, message: `Account #${accountId} logged out. New QR generating...` });
});

// GET /api/accounts/:id/chats - Get conversation list for an account
app.get('/api/accounts/:id/chats', async (req, res) => {
  const accountId = parseInt(req.params.id, 10);
  try {
    const chats = await database.getChatsForAccount(accountId);
    res.json(chats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/accounts/:id/chats/:phone/messages - Get chat history with a contact
app.get('/api/accounts/:id/chats/:phone/messages', async (req, res) => {
  const accountId = parseInt(req.params.id, 10);
  const cleanPhone = String(req.params.phone).replace(/[^0-9]/g, '');
  try {
    const messages = await database.getChatMessages(accountId, cleanPhone);
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/accounts/:id/messages/send - Send a message to a contact
app.post('/api/accounts/:id/messages/send', async (req, res) => {
  const accountId = parseInt(req.params.id, 10);
  const { phone, message } = req.body;

  if (!phone || !message || !message.trim()) {
    return res.status(400).json({ error: 'Phone number and message text are required.' });
  }

  try {
    const sentRecord = await waManager.sendMessageToPhone(accountId, phone, message.trim());
    res.json({ success: true, message: sentRecord });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/leads - List all tracked leads
app.get('/api/leads', async (req, res) => {
  try {
    const leads = await database.getLeads(100);
    res.json(leads);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/messages - List recent messages across all accounts
app.get('/api/messages', async (req, res) => {
  try {
    const messages = await database.getRecentMessages(50);
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats - High level metrics
app.get('/api/stats', async (req, res) => {
  try {
    const stats = await database.getStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/export - Export leads to CSV
app.get('/api/export', async (req, res) => {
  try {
    const leads = await database.getLeads(1000);
    const headers = ['Phone Number', 'Name', 'Account #', 'First Contact', 'Last Contact', 'Total Messages'];
    const rows = leads.map((l) => [
      `+${l.phone_number}`,
      `"${(l.name || '').replace(/"/g, '""')}"`,
      l.account_id,
      l.first_contact_at,
      l.last_contact_at,
      l.total_messages,
    ]);

    const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="leads_export_${new Date().toISOString().slice(0, 10)}.csv"`
    );
    res.send(csvContent);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/test-alert - Send a simulated notification to verify main number connection
app.post('/api/test-alert', async (req, res) => {
  if (!config.mainPhoneNumber) {
    return res.status(400).json({ error: 'Main phone number is not configured in .env' });
  }

  const mainJid = `${config.mainPhoneNumber}@s.whatsapp.net`;
  const testMessage =
    `🧪 *Test Notification from WhatsApp Multi-Hub*\n\n` +
    `Your system is configured properly! When any lead replies to your 4 business numbers, ` +
    `you will receive an instant notification like this right here on your main phone.`;

  const success = await waManager.broadcastToMain(mainJid, testMessage);
  if (success) {
    res.json({ success: true, message: 'Test alert sent successfully to your main WhatsApp!' });
  } else {
    res.status(500).json({
      error: 'Could not send test message. Make sure at least one business account is connected first!',
    });
  }
});

// POST /api/settings - Update configuration
app.post('/api/settings', (req, res) => {
  const { mainPhoneNumber, notificationStyle, debounceSeconds } = req.body;

  if (mainPhoneNumber !== undefined) {
    config.mainPhoneNumber = String(mainPhoneNumber).replace(/[^0-9]/g, '');
  }
  if (notificationStyle) {
    config.notificationStyle = notificationStyle;
  }
  if (debounceSeconds) {
    config.debounceSeconds = parseInt(debounceSeconds, 10);
  }

  // Persist to .env file
  try {
    const envPath = path.join(__dirname, '..', '.env');
    const envContent =
      `MAIN_PHONE_NUMBER=${config.mainPhoneNumber}\n` +
      `ACCOUNTS_COUNT=${config.accountsCount}\n` +
      `PORT=${config.port}\n` +
      `DEBOUNCE_SECONDS=${config.debounceSeconds}\n` +
      `NOTIFICATION_STYLE=${config.notificationStyle}\n`;
    fs.writeFileSync(envPath, envContent, 'utf8');
  } catch (err) {
    console.error('Failed to update .env file:', err);
  }

  res.json({ success: true, config });
});

async function start() {
  await database.init();
  await waManager.startAll();

  app.listen(config.port, () => {
    console.log(`\n======================================================`);
    console.log(`🚀 WhatsApp Multi-Hub is running!`);
    console.log(`🌐 Open dashboard: http://localhost:${config.port}`);
    console.log(`📱 Main WhatsApp:  ${config.mainPhoneNumber ? '+' + config.mainPhoneNumber : 'NOT CONFIGURED'}`);
    console.log(`======================================================\n`);
  });
}

start().catch((err) => {
  console.error('Fatal startup error:', err);
});
