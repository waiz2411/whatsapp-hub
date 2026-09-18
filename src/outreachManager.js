const config = require('./config');
const database = require('./database');

function cleanPhoneNumber(phone) {
  if (!phone) return '';
  return String(phone).replace(/[^0-9]/g, '');
}

/**
 * Parses daily lead list in "Phone, Name" format
 * Supports comma, tab, semicolon, or space separation
 */
function parseDailyLeadList(rawInput) {
  if (!rawInput) return [];
  if (Array.isArray(rawInput)) {
    return rawInput
      .map((item) => {
        const phone = cleanPhoneNumber(item.phone || item.phoneNumber || item[0]);
        const name = (item.name || item[1] || '').trim();
        return phone.length >= 7 && phone.length <= 16 ? { phone, name } : null;
      })
      .filter(Boolean);
  }

  if (typeof rawInput !== 'string') return [];

  const lines = rawInput.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  const parsed = [];
  const seen = new Set();

  let startIdx = 0;
  let phoneCol = 0;
  let nameCol = 1;

  // Header detection
  const firstLineCols = lines[0].split(/[,\t;|]/).map((c) => c.trim().replace(/^["']|["']$/g, ''));
  const col0Digits = cleanPhoneNumber(firstLineCols[0]);
  const col1Digits = firstLineCols.length > 1 ? cleanPhoneNumber(firstLineCols[1]) : '';

  if (col0Digits.length < 7 && col1Digits.length < 7) {
    const lowerCols = firstLineCols.map((c) => c.toLowerCase());
    if (lowerCols.some((c) => c.includes('phone') || c.includes('num') || c.includes('mobile') || c.includes('name') || c.includes('contact'))) {
      startIdx = 1;
      lowerCols.forEach((c, idx) => {
        if (c.includes('phone') || c.includes('num') || c.includes('mobile')) phoneCol = idx;
        if (c.includes('name') || c.includes('contact')) nameCol = idx;
      });
    }
  }

  for (let i = startIdx; i < lines.length; i++) {
    const cols = lines[i].split(/[,\t;|]/).map((c) => c.trim().replace(/^["']|["']$/g, ''));
    if (cols.length === 0) continue;

    let rawPhone = '';
    let name = '';

    if (cols.length === 1) {
      const parts = cols[0].split(/\s+/);
      rawPhone = parts[0];
      name = parts.slice(1).join(' ');
    } else {
      rawPhone = cols[phoneCol] || cols[0];
      name = cols[nameCol] || (phoneCol === 0 ? cols[1] : cols[0]) || '';
    }

    const cleanPhone = cleanPhoneNumber(rawPhone);
    if (cleanPhone.length >= 7 && cleanPhone.length <= 16) {
      if (!seen.has(cleanPhone)) {
        seen.add(cleanPhone);
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
 * Personalizes message template with {name} and {phone}
 */
function personalizeOutreachMessage(template, lead, fallbackName = 'there') {
  if (!template) return '';
  const nameVal = lead?.name && lead.name.trim().length > 0 ? lead.name.trim() : fallbackName;
  const phoneVal = lead?.phone_number || lead?.phone || '';

  return template
    .replace(/\{\{\s*name\s*\}\}/gi, nameVal)
    .replace(/\{\s*name\s*\}/gi, nameVal)
    .replace(/\{\{\s*phone\s*\}\}/gi, phoneVal)
    .replace(/\{\s*phone\s*\}/gi, phoneVal)
    .replace(/\{\{\s*number\s*\}\}/gi, phoneVal)
    .replace(/\{\s*number\s*\}/gi, phoneVal);
}

class OutreachManager {
  constructor(whatsappManager) {
    this.whatsappManager = whatsappManager;
    this.running = false;
    this.accountWorkers = new Map(); // accountId -> worker promise
    this.currentSendingItem = new Map(); // accountId -> item currently being sent
  }

  async startAll() {
    this.running = true;
    for (let i = 1; i <= config.accountsCount; i++) {
      this.startAccountWorker(i);
    }
    console.log(`🚀 [OutreachManager] Started dedicated daily outreach workers for all ${config.accountsCount} accounts (Pacing: 10–15 min delay per number).`);
  }

  stopAll() {
    this.running = false;
  }

  /**
   * Continuous background worker for a single connected WhatsApp account
   * Enforces 10 to 15-minute pacing between messages from THIS number
   */
  async startAccountWorker(accountId) {
    if (this.accountWorkers.has(accountId)) return;

    const workerLoop = (async () => {
      while (this.running) {
        try {
          const accState = await database.getOutreachAccountState(accountId);
          const isConnected = this.whatsappManager.isAccountConnected(accountId);

          // 1. If paused by user or account disconnected, sleep briefly and recheck
          if (!accState.is_active || !isConnected) {
            await this.sleep(3000);
            continue;
          }

          // 2. Check if there are any pending leads for this account
          const nextLead = await database.getNextPendingOutreachLead(accountId);
          if (!nextLead) {
            // Queue is empty, wait for user to add daily leads
            await this.sleep(4000);
            continue;
          }

          // 3. Check 10-15 minute pacing / countdown timer
          if (accState.next_run_at) {
            const nextRunTime = Date.parse(accState.next_run_at);
            const now = Date.now();
            if (now < nextRunTime) {
              // Not time yet! Sleep for remaining time (up to 3 seconds per check for quick responsiveness)
              const waitMs = Math.min(3000, nextRunTime - now);
              await this.sleep(waitMs);
              continue;
            }
          }

          // 4. Time to send! Mark as sending
          this.currentSendingItem.set(accountId, nextLead);
          await database.updateOutreachLead(nextLead.id, { status: 'sending' });

          const template = accState.custom_template || config.outreachMessage;
          const personalizedText = personalizeOutreachMessage(template, nextLead);

          console.log(`📨 [Outreach][Business #${accountId}] Sending to ${nextLead.name ? nextLead.name + ' (' : ''}+${nextLead.phone_number}${nextLead.name ? ')' : ''}...`);

          try {
            await this.whatsappManager.sendMessageToPhone(
              accountId,
              nextLead.phone_number,
              personalizedText,
              nextLead.name
            );

            // Mark as sent
            await database.updateOutreachLead(nextLead.id, {
              status: 'sent',
              sent_at: new Date().toISOString(),
              error: null,
            });

            console.log(`✅ [Outreach][Business #${accountId}] Message delivered successfully to +${nextLead.phone_number}`);
          } catch (sendErr) {
            console.error(`❌ [Outreach][Business #${accountId}] Send failed to +${nextLead.phone_number}:`, sendErr.message);
            await database.updateOutreachLead(nextLead.id, {
              status: 'failed',
              error: sendErr.message,
            });
          } finally {
            this.currentSendingItem.delete(accountId);
          }

          // 5. Compute next randomized delay of 10 to 15 minutes
          const minMin = accState.min_delay_minutes || 10;
          const maxMin = Math.max(minMin, accState.max_delay_minutes || 15);
          const randomMinutes = Math.random() * (maxMin - minMin) + minMin;
          const delayMs = Math.floor(randomMinutes * 60 * 1000);
          const nextRunAtIso = new Date(Date.now() + delayMs).toISOString();

          await database.updateOutreachAccountState(accountId, {
            next_run_at: nextRunAtIso,
            last_sent_at: new Date().toISOString(),
          });

          console.log(`⏳ [Outreach][Business #${accountId}] Next message scheduled in ${randomMinutes.toFixed(1)} minutes (at ${new Date(nextRunAtIso).toLocaleTimeString()}).`);

        } catch (loopErr) {
          console.error(`[Outreach][Business #${accountId}] Worker error:`, loopErr.message);
          await this.sleep(5000);
        }
      }
    })();

    this.accountWorkers.set(accountId, workerLoop);
  }

  /**
   * Upload / Add daily lead list for a specific connected number
   */
  async addDailyLeads(accountId, rawLeadsInput) {
    const leads = parseDailyLeadList(rawLeadsInput);
    if (leads.length === 0) {
      throw new Error('No valid phone numbers found in the provided lead list.');
    }

    const insertedCount = await database.addOutreachLeads(accountId, leads);

    // If account was idle with no scheduled send, reset next_run_at to now for immediate first send
    const state = await database.getOutreachAccountState(accountId);
    if (!state.last_sent_at || !state.next_run_at || Date.now() >= Date.parse(state.next_run_at)) {
      await database.updateOutreachAccountState(accountId, { next_run_at: null });
    }

    return {
      success: true,
      count: insertedCount,
      addedCount: insertedCount,
      message: `Added ${insertedCount} leads to Business #${accountId}'s daily outreach queue.`,
    };
  }

  async pauseAccount(accountId) {
    await database.updateOutreachAccountState(accountId, { is_active: 0 });
    return { success: true, message: `Business #${accountId} outreach paused.` };
  }

  async resumeAccount(accountId) {
    await database.updateOutreachAccountState(accountId, { is_active: 1 });
    return { success: true, message: `Business #${accountId} outreach resumed.` };
  }

  async clearQueue(accountId) {
    const cleared = await database.clearPendingOutreachLeads(accountId);
    await database.updateOutreachAccountState(accountId, { next_run_at: null });
    return { success: true, cleared, message: `Cleared ${cleared} pending leads from Business #${accountId}.` };
  }

  async updateAccountTemplate(accountId, template) {
    if (accountId) {
      await database.updateOutreachAccountState(accountId, { custom_template: template });
    } else {
      config.outreachMessage = template;
    }
    return { success: true, message: 'Outreach template updated.' };
  }

  /**
   * Get detailed status for an account including live countdown
   */
  async getAccountStatus(accountId) {
    const isConnected = this.whatsappManager.isAccountConnected(accountId);
    const accStates = this.whatsappManager.getAccountStates();
    const currentAcc = accStates.find((a) => a.id === accountId) || {};

    const state = await database.getOutreachAccountState(accountId);
    const summary = await database.getOutreachQueueSummary(accountId);
    const nextPending = await database.getNextPendingOutreachLead(accountId);
    const currentlySending = this.currentSendingItem.get(accountId);

    let status = 'idle';
    let secondsRemaining = 0;

    if (!isConnected) {
      status = 'disconnected';
    } else if (!state.is_active) {
      status = 'paused';
    } else if (currentlySending) {
      status = 'sending';
    } else if (summary.pending > 0) {
      if (state.next_run_at && Date.parse(state.next_run_at) > Date.now()) {
        status = 'waiting';
        secondsRemaining = Math.max(0, Math.ceil((Date.parse(state.next_run_at) - Date.now()) / 1000));
      } else {
        status = 'ready';
      }
    } else {
      status = 'idle';
    }

    return {
      accountId,
      accountName: currentAcc.name || `Business #${accountId}`,
      phoneNumber: currentAcc.phoneNumber || null,
      phone: currentAcc.phoneNumber || null,
      isConnected,
      isActive: Boolean(state.is_active),
      status,
      summary,
      total_leads: summary.total,
      pending_count: summary.pending,
      sent_count: summary.sent,
      failed_count: summary.failed,
      nextLead: nextPending ? { phone: nextPending.phone_number, name: nextPending.name } : null,
      currentlySending: currentlySending ? { phone: currentlySending.phone_number, name: currentlySending.name } : null,
      nextRunAt: state.next_run_at || null,
      next_run_at: state.next_run_at || null,
      secondsRemaining,
      lastSentAt: state.last_sent_at || null,
      minDelayMinutes: state.min_delay_minutes || config.outreachMinDelayMinutes || 10,
      maxDelayMinutes: state.max_delay_minutes || config.outreachMaxDelayMinutes || 15,
      template: state.custom_template || config.outreachMessage,
      state: {
        account_id: accountId,
        status: !state.is_active ? 'paused' : (summary.pending > 0 ? 'running' : 'idle'),
        pending_count: summary.pending,
        sent_count: summary.sent,
        failed_count: summary.failed,
        total_leads: summary.total,
        next_run_at: state.next_run_at || null,
      },
    };
  }

  async getAllAccountsStatus() {
    const statuses = [];
    for (let i = 1; i <= config.accountsCount; i++) {
      const status = await this.getAccountStatus(i);
      statuses.push(status);
    }
    return {
      globalTemplate: config.outreachMessage,
      minDelayMinutes: config.outreachMinDelayMinutes,
      maxDelayMinutes: config.outreachMaxDelayMinutes,
      accounts: statuses,
    };
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = {
  OutreachManager,
  parseDailyLeadList,
  personalizeOutreachMessage,
};
