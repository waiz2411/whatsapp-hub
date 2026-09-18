const database = require('./database');

function cleanPhoneNumber(phone) {
  if (!phone) return '';
  return String(phone).replace(/[^0-9]/g, '');
}

/**
 * Robust CSV/Text contact parser
 * Supports:
 * - CSV with or without headers (columns: phone/mobile/number, name/contact)
 * - Plain text line by line: "923001234567, Ali" or "923001234567 \t Ali"
 */
function parseContactsInput(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') return [];

  const lines = rawInput.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  const parsed = [];
  const seenNumbers = new Set();

  let headerDetected = false;
  let phoneColIndex = 0;
  let nameColIndex = 1;

  // Check if first line is a header (headers do NOT start with a real phone number)
  const firstLineCols = lines[0].split(/[,\t;|]/).map((c) => c.trim().replace(/^["']|["']$/g, ''));
  const firstColDigits = cleanPhoneNumber(firstLineCols[0]);
  const secondColDigits = firstLineCols.length > 1 ? cleanPhoneNumber(firstLineCols[1]) : '';

  // Only treat as header if neither column looks like a full phone number
  if (firstColDigits.length < 7 && secondColDigits.length < 7) {
    const lowerCols = firstLineCols.map((c) => c.toLowerCase());
    if (lowerCols.some((c) => c.includes('phone') || c.includes('num') || c.includes('mobile') || c.includes('contact') || c.includes('name'))) {
      headerDetected = true;
      for (let i = 0; i < lowerCols.length; i++) {
        const col = lowerCols[i];
        if (col.includes('phone') || col.includes('num') || col.includes('mobile')) {
          phoneColIndex = i;
        } else if (col.includes('name') || col.includes('contact')) {
          nameColIndex = i;
        }
      }
    }
  }

  const startLine = headerDetected ? 1 : 0;

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    // Split by comma, tab, semicolon, or pipe (respect basic quotes)
    const cols = line.split(/[,\t;|]/).map((c) => c.trim().replace(/^["']|["']$/g, ''));
    if (cols.length === 0) continue;

    let rawPhone = '';
    let name = '';

    if (cols.length === 1) {
      // Line only contains a number or "number name"
      const spaceParts = cols[0].split(/\s+/);
      rawPhone = spaceParts[0];
      name = spaceParts.slice(1).join(' ');
    } else {
      rawPhone = cols[phoneColIndex] || cols[0];
      name = cols[nameColIndex] || (phoneColIndex === 0 ? cols[1] : cols[0]) || '';
    }

    const cleanPhone = cleanPhoneNumber(rawPhone);
    // WhatsApp numbers are typically between 7 and 16 digits
    if (cleanPhone.length >= 7 && cleanPhone.length <= 16) {
      if (!seenNumbers.has(cleanPhone)) {
        seenNumbers.add(cleanPhone);
        parsed.push({
          phone: cleanPhone,
          name: name.trim(),
        });
      }
    }
  }

  return parsed;
}

/**
 * Replace placeholders {name} and {phone}
 */
function personalizeMessage(template, contact, fallbackName = 'there') {
  if (!template) return '';
  const nameVal = contact.name && contact.name.trim().length > 0 ? contact.name.trim() : fallbackName;
  const phoneVal = contact.phone || '';

  return template
    .replace(/\{\{\s*name\s*\}\}/gi, nameVal)
    .replace(/\{\s*name\s*\}/gi, nameVal)
    .replace(/\{\{\s*phone\s*\}\}/gi, phoneVal)
    .replace(/\{\s*phone\s*\}/gi, phoneVal)
    .replace(/\{\{\s*number\s*\}\}/gi, phoneVal)
    .replace(/\{\s*number\s*\}/gi, phoneVal);
}

class CampaignManager {
  constructor(whatsappManager) {
    this.whatsappManager = whatsappManager;
    this.activeRunners = new Map(); // campaignId -> { status: 'running'|'paused'|'stopped', stopRequested: bool }
  }

  /**
   * Distribute contacts across specified accounts and create campaign in SQLite
   */
  async prepareAndCreateCampaign({
    name,
    template,
    rawContacts,
    parsedContactsList = null,
    accountIds = [],
    minDelay = 6,
    maxDelay = 12,
    fallbackName = 'there',
  }) {
    const contacts = parsedContactsList || parseContactsInput(rawContacts);
    if (contacts.length === 0) {
      throw new Error('No valid phone numbers found in the uploaded list.');
    }

    const validAccountIds = accountIds && accountIds.length > 0 ? accountIds : this.whatsappManager.getConnectedAccountIds();
    if (validAccountIds.length === 0) {
      throw new Error('No WhatsApp accounts are available or selected. Link at least one account first.');
    }

    // Partition contacts across selected accounts
    // e.g. Round-robin or block distribution so each linked number gets its own list
    const items = [];
    for (let i = 0; i < contacts.length; i++) {
      const assignedAccountId = validAccountIds[i % validAccountIds.length];
      const contact = contacts[i];
      const personalizedText = personalizeMessage(template, contact, fallbackName);

      items.push({
        accountId: assignedAccountId,
        phone: contact.phone,
        name: contact.name,
        personalizedText,
      });
    }

    // Insert campaign and items into database
    const campaign = await database.createCampaign({
      name,
      template,
      minDelay: parseInt(minDelay, 10) || 6,
      maxDelay: parseInt(maxDelay, 10) || 12,
      items,
    });

    return campaign;
  }

  /**
   * Start or resume running a campaign
   */
  async startCampaign(campaignId) {
    const campaign = await database.getCampaign(campaignId);
    if (!campaign) {
      throw new Error(`Campaign #${campaignId} not found.`);
    }

    if (campaign.status === 'completed') {
      throw new Error(`Campaign #${campaignId} has already completed.`);
    }

    if (this.activeRunners.has(campaignId) && this.activeRunners.get(campaignId).status === 'running') {
      return { success: true, message: 'Campaign is already running.' };
    }

    const runnerState = {
      status: 'running',
      stopRequested: false,
      pauseRequested: false,
    };
    this.activeRunners.set(campaignId, runnerState);
    await database.updateCampaignStatus(campaignId, 'running');

    // Run parallel workers for each account involved in this campaign
    this.executeCampaignWorkers(campaignId, runnerState).catch((err) => {
      console.error(`Error in campaign runner #${campaignId}:`, err);
    });

    return { success: true, message: `Campaign #${campaignId} started.` };
  }

  /**
   * Pause a running campaign
   */
  async pauseCampaign(campaignId) {
    const runner = this.activeRunners.get(campaignId);
    if (runner) {
      runner.pauseRequested = true;
      runner.status = 'paused';
    }
    await database.updateCampaignStatus(campaignId, 'paused');
    return { success: true, message: `Campaign #${campaignId} paused.` };
  }

  /**
   * Stop / cancel a campaign completely
   */
  async stopCampaign(campaignId) {
    const runner = this.activeRunners.get(campaignId);
    if (runner) {
      runner.stopRequested = true;
      runner.status = 'stopped';
      this.activeRunners.delete(campaignId);
    }
    await database.updateCampaignStatus(campaignId, 'stopped');
    return { success: true, message: `Campaign #${campaignId} stopped.` };
  }

  /**
   * Background multi-account parallel worker
   */
  async executeCampaignWorkers(campaignId, runnerState) {
    const campaign = await database.getCampaign(campaignId);
    if (!campaign) return;

    // Determine all distinct account IDs in this campaign
    const accountIds = Object.keys(campaign.accountBreakdown).map((id) => parseInt(id, 10));

    // Each account gets its own worker loop running concurrently!
    const workerPromises = accountIds.map((accId) =>
      this.runAccountWorker(campaignId, accId, campaign.min_delay, campaign.max_delay, runnerState)
    );

    await Promise.all(workerPromises);

    // After all account workers finish or stop:
    if (runnerState.stopRequested) {
      await database.updateCampaignStatus(campaignId, 'stopped');
      this.activeRunners.delete(campaignId);
    } else if (runnerState.pauseRequested) {
      await database.updateCampaignStatus(campaignId, 'paused');
    } else {
      // Check if any pending items remain across all accounts
      const remainingItems = await database.getCampaignItems(campaignId);
      const pendingCount = remainingItems.filter((it) => it.status === 'pending').length;
      const sentCount = remainingItems.filter((it) => it.status === 'sent').length;
      const failedCount = remainingItems.filter((it) => it.status === 'failed').length;

      const finalStatus = pendingCount === 0 ? 'completed' : 'paused';
      await database.updateCampaignStatus(campaignId, finalStatus, {
        sent_count: sentCount,
        failed_count: failedCount,
      });
      this.activeRunners.delete(campaignId);
      console.log(`🏁 [Campaign #${campaignId}] Finished with status: ${finalStatus} (${sentCount} sent, ${failedCount} failed)`);
    }
  }

  /**
   * Worker loop for an individual account
   */
  async runAccountWorker(campaignId, accountId, minDelay, maxDelay, runnerState) {
    console.log(`🚀 [Campaign #${campaignId}] Starting sending loop for Business #${accountId}...`);

    while (!runnerState.stopRequested && !runnerState.pauseRequested) {
      const pendingItems = await database.getPendingCampaignItemsForAccount(campaignId, accountId);
      if (pendingItems.length === 0) {
        break; // All items for this account are processed
      }

      const item = pendingItems[0];

      // Check if account is connected
      if (!this.whatsappManager.isAccountConnected(accountId)) {
        console.warn(`⚠️ [Business #${accountId}] Disconnected during campaign. Waiting 5s...`);
        await this.sleep(5000);
        if (!this.whatsappManager.isAccountConnected(accountId)) {
          console.error(`❌ [Business #${accountId}] Still disconnected. Marking item #${item.id} failed.`);
          await database.updateCampaignItem(item.id, {
            status: 'failed',
            error: `Business #${accountId} is disconnected.`,
          });
          continue;
        }
      }

      // Mark as sending
      await database.updateCampaignItem(item.id, { status: 'sending' });

      try {
        await this.whatsappManager.sendMessageToPhone(
          accountId,
          item.phone_number,
          item.personalized_text,
          item.name
        );

        await database.updateCampaignItem(item.id, {
          status: 'sent',
          sent_at: new Date().toISOString(),
          error: null,
        });
        console.log(`✅ [Campaign #${campaignId}][Business #${accountId}] Sent to ${item.name ? item.name + ' (' : ''}+${item.phone_number}${item.name ? ')' : ''}`);
      } catch (err) {
        console.error(`❌ [Campaign #${campaignId}][Business #${accountId}] Failed to send to +${item.phone_number}:`, err.message);
        await database.updateCampaignItem(item.id, {
          status: 'failed',
          error: err.message,
        });
      }

      // Refresh campaign overall counts in DB
      const allItems = await database.getCampaignItems(campaignId);
      const sentCount = allItems.filter((i) => i.status === 'sent').length;
      const failedCount = allItems.filter((i) => i.status === 'failed').length;
      await database.updateCampaignStatus(campaignId, runnerState.status, {
        sent_count: sentCount,
        failed_count: failedCount,
      });

      if (runnerState.stopRequested || runnerState.pauseRequested) {
        break;
      }

      // Randomized anti-ban delay before this account sends its next message
      const delayMs = this.getRandomDelayMs(minDelay, maxDelay);
      await this.sleep(delayMs);
    }
  }

  getRandomDelayMs(minSec, maxSec) {
    const min = Math.max(2, minSec || 6);
    const max = Math.max(min, maxSec || 12);
    const chosenSec = Math.random() * (max - min) + min;
    return Math.floor(chosenSec * 1000);
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = {
  CampaignManager,
  parseContactsInput,
  personalizeMessage,
};
