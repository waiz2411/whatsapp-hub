const fs = require('fs');
const path = require('path');
const pino = require('pino');
const qrcode = require('qrcode');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const config = require('./config');
const database = require('./database');
const Notifier = require('./notifier');

class WhatsAppManager {
  constructor() {
    this.sockets = new Map(); // accountId -> socket
    this.accountStates = new Map(); // accountId -> { id, status, qrCode, phoneNumber, name }
    this.notifier = new Notifier(this);
    this.contactBook = new Map(); // `${accountId}_${phone}` -> name
    this.lidToPhone = new Map(); // `${accountId}_${lid}` -> phone

    // Initialize state objects
    for (let i = 1; i <= config.accountsCount; i++) {
      this.accountStates.set(i, {
        id: i,
        status: 'disconnected',
        qrCode: null,
        phoneNumber: null,
        name: `Business #${i}`,
      });
    }
  }

  async init() {
    if (!fs.existsSync(config.sessionsDir)) {
      fs.mkdirSync(config.sessionsDir, { recursive: true });
    }
  }

  async startAll() {
    await this.init();
    for (let i = 1; i <= config.accountsCount; i++) {
      this.startAccount(i);
    }
  }

  async startAccount(accountId) {
    const sessionPath = path.join(config.sessionsDir, `account_${accountId}`);
    if (!fs.existsSync(sessionPath)) {
      fs.mkdirSync(sessionPath, { recursive: true });
    }

    // Clean up any existing socket for this account before initializing a new one
    const existingSock = this.sockets.get(accountId);
    if (existingSock) {
      try {
        existingSock.ev.removeAllListeners();
        existingSock.end();
      } catch (err) {}
      this.sockets.delete(accountId);
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      syncFullHistory: false, // Keep false for ultra-stable connection and zero timeout loops
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
    });

    this.sockets.set(accountId, sock);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      const accountState = this.accountStates.get(accountId);

      if (qr) {
        try {
          const qrDataUrl = await qrcode.toDataURL(qr);
          accountState.qrCode = qrDataUrl;
          accountState.status = 'qr_ready';
          console.log(`📱 [Business #${accountId}] New QR code ready. Scan to link!`);
        } catch (err) {
          console.error(`Error generating QR for account #${accountId}:`, err);
        }
      }

      if (connection === 'connecting') {
        accountState.status = 'connecting';
      }

      if (connection === 'open') {
        accountState.status = 'connected';
        accountState.qrCode = null;
        const rawJid = sock.user?.id || '';
        const phone = rawJid.split(':')[0] || rawJid.split('@')[0];
        accountState.phoneNumber = phone;
        console.log(`✅ [Business #${accountId}] Connected! Phone: +${phone}`);

        await database.updateAccount(accountId, {
          status: 'connected',
          phone_number: phone,
          last_connected_at: new Date().toISOString(),
        });
      }

      if (connection === 'close') {
        accountState.status = 'disconnected';
        accountState.qrCode = null;

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(
          `⚠️ [Business #${accountId}] Connection closed (code: ${statusCode}). Reconnecting: ${shouldReconnect}`
        );

        await database.updateAccount(accountId, { status: 'disconnected' });

        if (shouldReconnect) {
          setTimeout(() => this.startAccount(accountId), 4000);
        } else {
          // IMPORTANT: NEVER automatically delete sessionPath here!
          // Automatic deletion wipes credentials during network glitches, restarts, or server redeployments.
          // Only explicit user action (clicking "Disconnect / Re-link" in UI) should delete session files.
          console.log(`🔒 [Business #${accountId}] Logged out or session closed by WhatsApp. Re-trying in 10s...`);
          setTimeout(() => this.startAccount(accountId), 10000);
        }
      }
    });

    // Track contacts & LID mappings
    sock.ev.on('contacts.upsert', (contacts) => {
      for (const c of contacts) {
        const id = c.id || '';
        const name = c.name || c.notify || c.verifiedName || '';

        // If ID is phone JID
        if (id.endsWith('@s.whatsapp.net')) {
          const phone = id.split('@')[0].split(':')[0];
          if (name) this.contactBook.set(`${accountId}_${phone}`, name);

          // If it also includes an LID
          if (c.lid) {
            const lid = c.lid.split('@')[0].split(':')[0];
            this.lidToPhone.set(`${accountId}_${lid}`, phone);
          }
        } else if (id.endsWith('@lid') && c.phoneNumber) {
          const lid = id.split('@')[0].split(':')[0];
          const phone = String(c.phoneNumber).replace(/[^0-9]/g, '');
          this.lidToPhone.set(`${accountId}_${lid}`, phone);
          if (name) this.contactBook.set(`${accountId}_${phone}`, name);
        }
      }
    });

    // Handle incoming messages
    sock.ev.on('messages.upsert', async (upsert) => {
      if (upsert.type !== 'notify') return;

      for (const msg of upsert.messages) {
        if (!msg.message) continue;

        // 1. Ignore messages sent by ourselves
        if (msg.key?.fromMe) continue;

        const rawJid = msg.key?.remoteJid || '';

        // 2. Ignore status broadcasts & group chats
        if (rawJid.includes('broadcast') || rawJid.endsWith('@g.us')) continue;

        // 3. Ignore messages from own account or own LID
        const myJid = sock.user?.id || '';
        const myLid = sock.user?.lid || '';
        if (
          (myJid && rawJid.includes(myJid.split(':')[0])) ||
          (myLid && rawJid.includes(myLid.split(':')[0]))
        ) {
          continue;
        }

        // 4. Extract Real Phone Number
        let leadPhone = '';
        if (rawJid.endsWith('@s.whatsapp.net')) {
          leadPhone = rawJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
        } else if (rawJid.endsWith('@lid')) {
          const lidDigits = rawJid.split('@')[0].split(':')[0];
          // Try lookup in LID to phone map
          leadPhone = this.lidToPhone.get(`${accountId}_${lidDigits}`) || '';
          // Check participant JID fallback
          if (!leadPhone && msg.key?.participant && msg.key.participant.endsWith('@s.whatsapp.net')) {
            leadPhone = msg.key.participant.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
          }
          // If still unresolved, fallback to LID without treating it as phone
          if (!leadPhone) {
            leadPhone = lidDigits;
          }
        } else {
          leadPhone = rawJid.replace(/[^0-9]/g, '');
        }

        if (!leadPhone) continue;

        // 5. Extract sender display name
        const leadName =
          msg.pushName ||
          this.contactBook.get(`${accountId}_${leadPhone}`) ||
          '';

        // 6. Extract actual text content (returns null for protocol/sync/reactions)
        const body = this.notifier.extractMessageText(msg);
        if (!body) continue; // Drop internal protocol / empty / reaction messages

        const msgTimestamp = msg.messageTimestamp ? msg.messageTimestamp * 1000 : Date.now();

        console.log(`📩 [Business #${accountId}] New message from ${leadName ? leadName + ' (' : ''}+${leadPhone}${leadName ? ')' : ''}: "${body}"`);

        // Record to local SQLite database
        await database.recordMessage({
          accountId,
          leadPhone,
          leadName,
          fromMe: false,
          body,
          timestamp: msgTimestamp,
        });

        // Trigger instant alert notification to your main WhatsApp number
        this.notifier.queueNotification(accountId, msg, leadPhone, leadName, body);
      }
    });
  }

  isAccountConnected(accountId) {
    const accState = this.accountStates.get(accountId);
    return this.sockets.has(accountId) && accState?.status === 'connected';
  }

  getConnectedAccountIds() {
    const ids = [];
    for (const [accId, state] of this.accountStates.entries()) {
      if (state.status === 'connected' && this.sockets.has(accId)) {
        ids.push(accId);
      }
    }
    return ids.sort((a, b) => a - b);
  }

  async sendMessageToPhone(accountId, phone, text, contactName = null) {
    const cleanPhone = String(phone).replace(/[^0-9]/g, '');
    if (!cleanPhone) {
      throw new Error('Invalid phone number: No digits found.');
    }

    const sock = this.sockets.get(accountId);
    if (!sock || !this.isAccountConnected(accountId)) {
      throw new Error(`Business #${accountId} is not connected to WhatsApp.`);
    }

    const jid = `${cleanPhone}@s.whatsapp.net`;
    try {
      await sock.sendMessage(jid, { text });
    } catch (err) {
      console.error(`❌ [Business #${accountId}] Failed to send message to +${cleanPhone}:`, err.message);
      throw err;
    }

    // Record outbound message in SQLite
    const record = await database.recordMessage({
      accountId,
      leadPhone: cleanPhone,
      leadName: contactName || null,
      fromMe: true,
      body: text,
      timestamp: Date.now(),
    });

    return record;
  }

  async sendMessage(accountId, toJid, text) {
    const sock = this.sockets.get(accountId);
    if (!sock || this.accountStates.get(accountId)?.status !== 'connected') {
      return false;
    }

    try {
      await sock.sendMessage(toJid, { text });
      return true;
    } catch (err) {
      console.error(`Failed to send alert from Business #${accountId}:`, err.message);
      return false;
    }
  }

  async broadcastToMain(mainJid, text, excludeAccountId = null) {
    for (const [accId, sock] of this.sockets.entries()) {
      if (excludeAccountId && accId === excludeAccountId) continue;
      if (this.accountStates.get(accId)?.status === 'connected') {
        try {
          await sock.sendMessage(mainJid, { text });
          return true;
        } catch (err) {
          continue;
        }
      }
    }
    return false;
  }

  async logoutAccount(accountId) {
    const sock = this.sockets.get(accountId);
    if (sock) {
      try {
        await sock.logout();
      } catch (err) {}
    }
    const sessionPath = path.join(config.sessionsDir, `account_${accountId}`);
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }
    this.accountStates.set(accountId, {
      id: accountId,
      status: 'disconnected',
      qrCode: null,
      phoneNumber: null,
      name: `Business #${accountId}`,
    });
    await database.updateAccount(accountId, { status: 'disconnected', phone_number: null });
    setTimeout(() => this.startAccount(accountId), 1000);
  }

  getAccountStates() {
    return Array.from(this.accountStates.values());
  }
}

module.exports = WhatsAppManager;
