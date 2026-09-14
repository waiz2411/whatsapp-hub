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
  debounceSeconds: parseInt(process.env.DEBOUNCE_SECONDS || '15', 10),
  notificationStyle: (process.env.NOTIFICATION_STYLE || 'detailed').toLowerCase(),
  sessionsDir: path.join(__dirname, '..', 'sessions'),
  dataDir: path.join(__dirname, '..', 'data'),
  dbPath: path.join(__dirname, '..', 'data', 'tracker.sqlite'),
};

module.exports = config;
