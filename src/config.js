const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function cleanPhoneNumber(phone) {
  if (!phone) return '';
  return String(phone).replace(/[^0-9]/g, '');
}

const config = {
  mainPhoneNumber: cleanPhoneNumber(process.env.MAIN_PHONE_NUMBER || ''),
  accountsCount: parseInt(process.env.ACCOUNTS_COUNT || '4', 10),
  port: parseInt(process.env.PORT || '7860', 10),
  debounceSeconds: parseInt(process.env.DEBOUNCE_SECONDS || '3', 10),
  notificationStyle: (process.env.NOTIFICATION_STYLE || 'detailed').toLowerCase(),
  sessionsDir: path.join(__dirname, '..', 'sessions'),
  dataDir: path.join(__dirname, '..', 'data'),
  dbPath: path.join(__dirname, '..', 'data', 'tracker.sqlite'),

  // ============================================================================
  // 📨 MAIN OUTREACH MESSAGE TEMPLATE
  // Attach your outreach message here. Use {name} for personalization.
  // Example: "Hello {name}, hope you're having a great week! ..."
  // ============================================================================
  outreachMessage:
    process.env.OUTREACH_MESSAGE ||
    "Hello {name}! Hope you are having a wonderful week. Reaching out to connect regarding our special update. Would love to share details if you're interested!",

  // ⏱️ Delay in minutes between messages from the SAME number (10 to 15 minutes)
  outreachMinDelayMinutes: parseInt(process.env.OUTREACH_MIN_DELAY_MINUTES || '10', 10),
  outreachMaxDelayMinutes: parseInt(process.env.OUTREACH_MAX_DELAY_MINUTES || '15', 10),
};

module.exports = config;
