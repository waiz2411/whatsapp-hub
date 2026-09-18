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
const { CampaignManager, parseContactsInput, personalizeMessage } = require('./campaignManager');
const { OutreachManager, parseDailyLeadList, personalizeOutreachMessage } = require('./outreachManager');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const waManager = new WhatsAppManager();
const campaignManager = new CampaignManager(waManager);
const outreachManager = new OutreachManager(waManager);

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

// POST /api/campaigns/preview - Parse raw contacts and calculate multi-account split preview
app.post('/api/campaigns/preview', (req, res) => {
  try {
    const { rawContacts, template, accountIds, fallbackName } = req.body;
    const contacts = parseContactsInput(rawContacts || '');
    const connectedAccounts = waManager.getConnectedAccountIds();
    const targetAccounts = accountIds && accountIds.length > 0 ? accountIds : connectedAccounts;

    const samplePreview = contacts.slice(0, 5).map((c, index) => {
      const assignedAccount = targetAccounts.length > 0 ? targetAccounts[index % targetAccounts.length] : null;
      return {
        phone: c.phone,
        name: c.name,
        assignedAccountId: assignedAccount,
        renderedMessage: personalizeMessage(template || '', c, fallbackName || 'there'),
      };
    });

    res.json({
      totalContacts: contacts.length,
      connectedAccounts,
      targetAccounts,
      samplePreview,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/campaigns - Create a new bulk campaign with per-account distribution
app.post('/api/campaigns', async (req, res) => {
  try {
    const { name, template, rawContacts, parsedContactsList, accountIds, minDelay, maxDelay, fallbackName } = req.body;

    if (!template || !template.trim()) {
      return res.status(400).json({ error: 'Message template is required.' });
    }

    const campaign = await campaignManager.prepareAndCreateCampaign({
      name,
      template: template.trim(),
      rawContacts,
      parsedContactsList,
      accountIds,
      minDelay: minDelay || 6,
      maxDelay: maxDelay || 12,
      fallbackName: fallbackName || 'there',
    });

    res.json({ success: true, campaign });
  } catch (err) {
    console.error('Error creating campaign:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// GET /api/campaigns - List all campaigns
app.get('/api/campaigns', async (req, res) => {
  try {
    const campaigns = await database.getAllCampaigns();
    res.json(campaigns);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/campaigns/:id - Get campaign details & contact items
app.get('/api/campaigns/:id', async (req, res) => {
  try {
    const campaignId = parseInt(req.params.id, 10);
    const campaign = await database.getCampaign(campaignId);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const items = await database.getCampaignItems(campaignId);
    res.json({ campaign, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns/:id/start - Start or resume campaign execution
app.post('/api/campaigns/:id/start', async (req, res) => {
  try {
    const campaignId = parseInt(req.params.id, 10);
    const result = await campaignManager.startCampaign(campaignId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/campaigns/:id/pause - Pause running campaign
app.post('/api/campaigns/:id/pause', async (req, res) => {
  try {
    const campaignId = parseInt(req.params.id, 10);
    const result = await campaignManager.pauseCampaign(campaignId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/campaigns/:id/stop - Stop/cancel campaign
app.post('/api/campaigns/:id/stop', async (req, res) => {
  try {
    const campaignId = parseInt(req.params.id, 10);
    const result = await campaignManager.stopCampaign(campaignId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/notifications/recent - List recent alerts sent to main phone
app.get('/api/notifications/recent', async (req, res) => {
  try {
    const logs = await database.getRecentNotifications(50);
    res.json(logs);
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

// ============================================================================
// Dedicated Per-Number Daily Outreach API Endpoints
// ============================================================================

// GET /api/outreach/status - Live status for all accounts (queues, countdowns, pacing)
app.get('/api/outreach/status', async (req, res) => {
  try {
    const status = await outreachManager.getAllAccountsStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/outreach/template - Update the main outreach template
app.post('/api/outreach/template', async (req, res) => {
  try {
    const { template, accountId } = req.body;
    if (!template || !template.trim()) {
      return res.status(400).json({ error: 'Template cannot be empty' });
    }

    await outreachManager.updateAccountTemplate(accountId ? parseInt(accountId, 10) : null, template.trim());

    // Persist to .env if global
    if (!accountId) {
      try {
        const envPath = path.join(__dirname, '..', '.env');
        let envText = fs.readFileSync(envPath, 'utf8');
        if (envText.includes('OUTREACH_MESSAGE=')) {
          envText = envText.replace(/OUTREACH_MESSAGE=.*(\r?\n|$)/, `OUTREACH_MESSAGE=${template.trim()}\n`);
        } else {
          envText += `\nOUTREACH_MESSAGE=${template.trim()}\n`;
        }
        fs.writeFileSync(envPath, envText, 'utf8');
      } catch (e) {
        console.error('Failed to write template to .env:', e);
      }
    }

    res.json({ success: true, message: 'Outreach template updated successfully.', template: template.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/outreach/accounts/:id/leads - Add daily lead list for specific connected account
app.post('/api/outreach/accounts/:id/leads', async (req, res) => {
  try {
    const accountId = parseInt(req.params.id, 10);
    const { leads, rawLeads } = req.body;

    const result = await outreachManager.addDailyLeads(accountId, leads || rawLeads || '');
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/outreach/accounts/:id/pause - Pause outreach for this number
app.post('/api/outreach/accounts/:id/pause', async (req, res) => {
  try {
    const accountId = parseInt(req.params.id, 10);
    const result = await outreachManager.pauseAccount(accountId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/outreach/accounts/:id/resume - Resume outreach for this number
app.post('/api/outreach/accounts/:id/resume', async (req, res) => {
  try {
    const accountId = parseInt(req.params.id, 10);
    const result = await outreachManager.resumeAccount(accountId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/outreach/accounts/:id/clear - Clear pending leads queue for this number
app.post('/api/outreach/accounts/:id/clear', async (req, res) => {
  try {
    const accountId = parseInt(req.params.id, 10);
    const result = await outreachManager.clearQueue(accountId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/outreach/accounts/:id/queue - Inspect full lead queue for this number
app.get('/api/outreach/accounts/:id/queue', async (req, res) => {
  try {
    const accountId = parseInt(req.params.id, 10);
    const limit = parseInt(req.query.limit || '100', 10);
    const status = req.query.status || null;
    const leads = await database.getOutreachLeads(accountId, limit, status);
    res.json(leads);
  } catch (err) {
    res.status(500).json({ error: err.message });
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
      `NOTIFICATION_STYLE=${config.notificationStyle}\n` +
      `OUTREACH_MESSAGE=${config.outreachMessage}\n` +
      `OUTREACH_MIN_DELAY_MINUTES=${config.outreachMinDelayMinutes}\n` +
      `OUTREACH_MAX_DELAY_MINUTES=${config.outreachMaxDelayMinutes}\n`;
    fs.writeFileSync(envPath, envContent, 'utf8');
  } catch (err) {
    console.error('Failed to update .env file:', err);
  }

  res.json({ success: true, config });
});

async function start() {
  await database.init();
  await waManager.startAll();
  await outreachManager.startAll();

  app.listen(config.port, () => {
    console.log(`\n======================================================`);
    console.log(`🚀 WhatsApp Multi-Hub is running!`);
    console.log(`🌐 Open dashboard: http://localhost:${config.port}`);
    console.log(`📱 Main WhatsApp:  ${config.mainPhoneNumber ? '+' + config.mainPhoneNumber : 'NOT CONFIGURED'}`);
    console.log(`⏱️ Outreach Delay: ${config.outreachMinDelayMinutes} - ${config.outreachMaxDelayMinutes} minutes per number`);
    console.log(`======================================================\n`);
  });
}

start().catch((err) => {
  console.error('Fatal startup error:', err);
});
