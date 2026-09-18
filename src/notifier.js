const config = require('./config');
const database = require('./database');

// In-memory buffer to debounce rapid consecutive messages per lead
const debounceBuffers = new Map();

function cleanDigits(phone) {
  if (!phone) return '';
  return String(phone).replace(/[^0-9]/g, '');
}

/**
 * Recursively unwraps Baileys nested message structures
 * (ephemeralMessage, viewOnceMessage, viewOnceMessageV2, etc.)
 */
function unwrapMessage(msgObj) {
  if (!msgObj) return null;
  let current = msgObj;

  while (current) {
    if (current.ephemeralMessage?.message) {
      current = current.ephemeralMessage.message;
    } else if (current.viewOnceMessage?.message) {
      current = current.viewOnceMessage.message;
    } else if (current.viewOnceMessageV2?.message) {
      current = current.viewOnceMessageV2.message;
    } else if (current.viewOnceMessageV2Extension?.message) {
      current = current.viewOnceMessageV2Extension.message;
    } else if (current.documentWithCaptionMessage?.message) {
      current = current.documentWithCaptionMessage.message;
    } else {
      break;
    }
  }

  return current;
}

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
    const cleanMain = cleanDigits(config.mainPhoneNumber);
    const cleanSender = cleanDigits(senderNumber);
    if (cleanMain && cleanSender === cleanMain) {
      return false;
    }

    return true;
  }

  /**
   * Extract real text content from WhatsApp message.
   * Unwraps all nested message containers (viewOnce, ephemeral, etc.)
   * Returns null if it is a protocol/sync message, reaction, or empty.
   */
  extractMessageText(msg) {
    const rawMessage = msg?.message;
    if (!rawMessage) return null;

    const message = unwrapMessage(rawMessage);
    if (!message) return null;

    // Ignore pure protocol / reaction messages with no user content
    if (message.protocolMessage || message.reactionMessage || message.senderKeyDistributionMessage) {
      return null;
    }

    const text =
      message.conversation ||
      message.extendedTextMessage?.text ||
      message.imageMessage?.caption ||
      message.videoMessage?.caption ||
      (message.documentMessage ? `[Document: ${message.documentMessage.fileName || 'file'}]` : null) ||
      (message.imageMessage ? '[Photo]' : null) ||
      (message.videoMessage ? '[Video]' : null) ||
      (message.audioMessage ? '[Voice Message]' : null) ||
      (message.contactMessage ? '[Contact Card]' : null) ||
      (message.locationMessage ? '[Location Shared]' : null) ||
      message.interactiveResponseMessage?.body?.text ||
      message.buttonsResponseMessage?.selectedDisplayText ||
      message.buttonsResponseMessage?.selectedButtonId ||
      message.listResponseMessage?.title ||
      message.listResponseMessage?.singleSelectReply?.selectedRowId ||
      message.templateButtonReplyMessage?.selectedDisplayText ||
      (message.pollCreationMessage ? `[Poll: ${message.pollCreationMessage.name || 'Poll'}]` : null);

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
    const debounceMs = Math.max(1, (config.debounceSeconds || 3)) * 1000;

    if (debounceBuffers.has(bufferKey)) {
      const entry = debounceBuffers.get(bufferKey);
      entry.messages.push(messageText);
      if (senderName && !entry.senderName) entry.senderName = senderName;

      clearTimeout(entry.timeoutId);
      entry.timeoutId = setTimeout(() => {
        this.dispatchNotification(accountId, senderNumber, entry.senderName, entry.messages);
        debounceBuffers.delete(bufferKey);
      }, debounceMs);
    } else {
      const timeoutId = setTimeout(() => {
        const entry = debounceBuffers.get(bufferKey);
        if (entry) {
          this.dispatchNotification(accountId, senderNumber, entry.senderName, entry.messages);
          debounceBuffers.delete(bufferKey);
        }
      }, debounceMs);

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
    const cleanMain = cleanDigits(config.mainPhoneNumber);
    if (!cleanMain) {
      console.warn('⚠️ Notification skipped: MAIN_PHONE_NUMBER is empty.');
      return;
    }

    const mainJid = `${cleanMain}@s.whatsapp.net`;
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

    let success = false;
    let errorMsg = null;

    try {
      // Check if accountId's phone number is identical to mainPhoneNumber (avoid self-send loop)
      const accState = this.whatsappManager.accountStates.get(accountId);
      const accPhone = cleanDigits(accState?.phoneNumber);

      if (accPhone && accPhone === cleanMain) {
        // Use another connected business account to send to the main phone
        success = await this.whatsappManager.broadcastToMain(mainJid, notificationText, accountId);
      } else {
        success = await this.whatsappManager.sendMessage(accountId, mainJid, notificationText);
        if (!success) {
          success = await this.whatsappManager.broadcastToMain(mainJid, notificationText, accountId);
        }
      }

      if (success) {
        console.log(`✅ Alert sent to main number (+${cleanMain}) for Business #${accountId}`);
      } else {
        errorMsg = 'No connected business account could reach main number.';
        console.error(`❌ Alert delivery failed: ${errorMsg}`);
      }
    } catch (err) {
      errorMsg = err.message;
      console.error(`❌ Error sending notification to main number:`, err.message);
    }

    // Persist alert log in SQLite for user visibility in the dashboard
    try {
      await database.logNotification({
        accountId,
        senderPhone,
        senderName,
        messageText: messages.join(' | '),
        status: success ? 'sent' : 'failed',
        error: errorMsg,
      });
    } catch (dbErr) {
      console.error('Failed to log notification to database:', dbErr.message);
    }
  }
}

module.exports = Notifier;
