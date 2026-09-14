const config = require('./config');

// In-memory buffer to debounce rapid consecutive messages per lead
const debounceBuffers = new Map();

class Notifier {
  constructor(whatsappManager) {
    this.whatsappManager = whatsappManager;
  }

  /**
   * Determine if an incoming message should trigger a notification
   */
  shouldNotify(accountId, msg, senderNumber) {
    if (!msg || !msg.message) return false;

    // Ignore messages sent by ourselves
    if (msg.key?.fromMe) return false;

    const jid = msg.key?.remoteJid || '';

    // Ignore status broadcasts
    if (jid.includes('broadcast')) return false;

    // Ignore group chats
    if (jid.endsWith('@g.us')) return false;

    // Anti-loop: Ignore messages from your own main phone number
    if (config.mainPhoneNumber && senderNumber === config.mainPhoneNumber) {
      return false;
    }

    return true;
  }

  /**
   * Extract real text content from WhatsApp message.
   * Returns null if it is a protocol/sync message, reaction, or empty.
   */
  extractMessageText(msg) {
    const message = msg?.message;
    if (!message) return null;

    // Ignore internal protocol / reaction / sync messages
    if (
      message.protocolMessage ||
      message.reactionMessage ||
      message.senderKeyDistributionMessage ||
      message.keyStateNotification ||
      message.messageContextInfo
    ) {
      return null;
    }

    const text =
      message.conversation ||
      message.extendedTextMessage?.text ||
      message.imageMessage?.caption ||
      message.videoMessage?.caption ||
      (message.documentMessage ? `[Document: ${message.documentMessage.fileName || 'file'}]` : null) ||
      (message.audioMessage ? '[Voice Message]' : null) ||
      (message.contactMessage ? '[Contact Card]' : null) ||
      (message.locationMessage ? '[Location Shared]' : null);

    return text && text.trim().length > 0 ? text.trim() : null;
  }

  /**
   * Queue incoming message for debounced notification
   */
  queueNotification(accountId, msg, senderNumber, senderName, messageText) {
    if (!this.shouldNotify(accountId, msg, senderNumber)) return;

    if (!config.mainPhoneNumber) {
      console.warn('⚠️ Notification skipped: MAIN_PHONE_NUMBER is not configured.');
      return;
    }

    const bufferKey = `${accountId}_${senderNumber}`;

    if (debounceBuffers.has(bufferKey)) {
      const entry = debounceBuffers.get(bufferKey);
      entry.messages.push(messageText);
      if (senderName && !entry.senderName) entry.senderName = senderName;

      clearTimeout(entry.timeoutId);
      entry.timeoutId = setTimeout(() => {
        this.dispatchNotification(accountId, senderNumber, entry.senderName, entry.messages);
        debounceBuffers.delete(bufferKey);
      }, config.debounceSeconds * 1000);
    } else {
      const timeoutId = setTimeout(() => {
        const entry = debounceBuffers.get(bufferKey);
        if (entry) {
          this.dispatchNotification(accountId, senderNumber, entry.senderName, entry.messages);
          debounceBuffers.delete(bufferKey);
        }
      }, config.debounceSeconds * 1000);

      debounceBuffers.set(bufferKey, {
        timeoutId,
        messages: [messageText],
        senderName,
      });
    }
  }

  /**
   * Send formatted alert text to your main WhatsApp number
   */
  async dispatchNotification(accountId, senderPhone, senderName, messages) {
    const mainJid = `${config.mainPhoneNumber}@s.whatsapp.net`;
    const messagePreview = messages.map((m) => (messages.length > 1 ? `• ${m}` : `"${m}"`)).join('\n');
    const senderDisplay = senderName ? `${senderName} (+${senderPhone})` : `+${senderPhone}`;

    let notificationText = '';
    if (config.notificationStyle === 'minimal') {
      notificationText = `🔔 *New message on Business #${accountId}*\nFrom: ${senderDisplay}\nTap to chat: https://wa.me/${senderPhone}`;
    } else {
      notificationText =
        `🚨 *New WhatsApp Reply on Business #${accountId}!*\n\n` +
        `👤 *From:* ${senderDisplay}\n` +
        `💬 *Message:* \n${messagePreview}\n\n` +
        `🔗 *Open Chat:* https://wa.me/${senderPhone}`;
    }

    try {
      const success = await this.whatsappManager.sendMessage(accountId, mainJid, notificationText);
      if (success) {
        console.log(`✅ Alert sent to main number (+${config.mainPhoneNumber}) from Business #${accountId}`);
      } else {
        const fallbackSuccess = await this.whatsappManager.broadcastToMain(mainJid, notificationText);
        if (fallbackSuccess) {
          console.log(`✅ Alert dispatched via fallback account to +${config.mainPhoneNumber}`);
        } else {
          console.error(`❌ Could not send alert: No business accounts connected.`);
        }
      }
    } catch (err) {
      console.error(`❌ Error sending notification:`, err.message);
    }
  }
}

module.exports = Notifier;
