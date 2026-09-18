const assert = require('assert');

process.env.MAIN_PHONE_NUMBER = '19998887777';
process.env.PORT = '3002';

const database = require('../src/database');
const { parseContactsInput, personalizeMessage } = require('../src/campaignManager');
const Notifier = require('../src/notifier');

async function runCampaignTests() {
  console.log('🧪 Starting Campaign & Notification Guarantee Tests...\n');

  await database.init();

  // Test 1: Contact Parsing
  console.log('Test 1: parseContactsInput with CSV headers and mixed formats');
  const csvData = `Phone Number, Contact Name
+1 (415) 555-0101, Alice Smith
923001234567, "Bob Jones"
+44 7911 123456, Charlie
14155550101, Alice Duplicate
invalid-number, No Phone
+1 (415) 555-0199, `;

  const parsed = parseContactsInput(csvData);
  assert.strictEqual(parsed.length, 4, 'Should parse 4 valid unique contacts (ignoring duplicates and invalid)');
  assert.strictEqual(parsed[0].phone, '14155550101');
  assert.strictEqual(parsed[0].name, 'Alice Smith');
  assert.strictEqual(parsed[1].phone, '923001234567');
  assert.strictEqual(parsed[1].name, 'Bob Jones');
  assert.strictEqual(parsed[2].phone, '447911123456');
  assert.strictEqual(parsed[2].name, 'Charlie');
  assert.strictEqual(parsed[3].phone, '14155550199');
  assert.strictEqual(parsed[3].name, '');
  console.log('  ✅ Contact parsing and deduplication passed');

  // Test 2: Template Personalization
  console.log('Test 2: personalizeMessage');
  const template = 'Hello {name}! We have a special offer for your number {phone}. Reply YES to learn more.';
  const msg1 = personalizeMessage(template, parsed[0], 'friend');
  assert.strictEqual(msg1, 'Hello Alice Smith! We have a special offer for your number 14155550101. Reply YES to learn more.');

  const msg2 = personalizeMessage(template, parsed[3], 'there');
  assert.strictEqual(msg2, 'Hello there! We have a special offer for your number 14155550199. Reply YES to learn more.');
  console.log('  ✅ Message personalization with fallback passed');

  // Test 3: Campaign Database Creation & Multi-Account Partitioning
  console.log('Test 3: Campaign Database operations & account assignment');
  const items = [
    { accountId: 1, phone: parsed[0].phone, name: parsed[0].name, personalizedText: msg1 },
    { accountId: 2, phone: parsed[1].phone, name: parsed[1].name, personalizedText: 'Hi Bob' },
    { accountId: 3, phone: parsed[2].phone, name: parsed[2].name, personalizedText: 'Hi Charlie' },
    { accountId: 4, phone: parsed[3].phone, name: parsed[3].name, personalizedText: msg2 },
  ];

  const campaign = await database.createCampaign({
    name: 'Test Bulk Campaign',
    template,
    minDelay: 5,
    maxDelay: 10,
    items,
  });

  assert(campaign.id, 'Campaign should be created with an ID');
  assert.strictEqual(campaign.total_contacts, 4);
  assert.strictEqual(campaign.accountBreakdown[1].total, 1);
  assert.strictEqual(campaign.accountBreakdown[2].total, 1);
  assert.strictEqual(campaign.accountBreakdown[3].total, 1);
  assert.strictEqual(campaign.accountBreakdown[4].total, 1);

  const campaignItems = await database.getCampaignItems(campaign.id);
  assert.strictEqual(campaignItems.length, 4);
  assert.strictEqual(campaignItems[0].status, 'pending');

  // Test updating item status
  await database.updateCampaignItem(campaignItems[0].id, {
    status: 'sent',
    sent_at: new Date().toISOString(),
  });
  const updatedCampaign = await database.getCampaign(campaign.id);
  assert.strictEqual(updatedCampaign.accountBreakdown[1].sent, 1);
  assert.strictEqual(updatedCampaign.accountBreakdown[1].pending, 0);
  console.log('  ✅ Campaign creation, item breakdown, and status updates passed');

  // Test 4: Notifier Unwrapping & Message Text Extraction
  console.log('Test 4: Notifier unwrapMessage and extractMessageText');
  const mockWhatsappManager = {
    accountStates: new Map([
      [1, { id: 1, status: 'connected', phoneNumber: '14155550001' }],
      [2, { id: 2, status: 'connected', phoneNumber: '14155550002' }],
    ]),
    sockets: new Map(),
    async sendMessage(accId, jid, text) { return true; },
    async broadcastToMain(jid, text) { return true; },
  };

  const notifier = new Notifier(mockWhatsappManager);

  // Test standard text message
  const textMsg = { message: { conversation: 'I want pricing' } };
  assert.strictEqual(notifier.extractMessageText(textMsg), 'I want pricing');

  // Test wrapped ephemeral message
  const ephemeralMsg = {
    message: {
      ephemeralMessage: {
        message: {
          extendedTextMessage: { text: 'Can you call me?' },
        },
      },
    },
  };
  assert.strictEqual(notifier.extractMessageText(ephemeralMsg), 'Can you call me?');

  // Test view-once photo message
  const viewOnceMsg = {
    message: {
      viewOnceMessageV2: {
        message: {
          imageMessage: { caption: 'Receipt image' },
        },
      },
    },
  };
  assert.strictEqual(notifier.extractMessageText(viewOnceMsg), 'Receipt image');

  // Test interactive button reply
  const buttonMsg = {
    message: {
      buttonsResponseMessage: { selectedDisplayText: 'Yes, Interested' },
    },
  };
  assert.strictEqual(notifier.extractMessageText(buttonMsg), 'Yes, Interested');

  console.log('  ✅ Nested message unwrapping and extraction passed');

  // Test 5: Notification Logging
  console.log('Test 5: Notification logging in SQLite');
  await database.logNotification({
    accountId: 1,
    senderPhone: '14155550101',
    senderName: 'Alice Smith',
    messageText: 'I want pricing',
    status: 'sent',
    error: null,
  });

  const recentLogs = await database.getRecentNotifications(10);
  assert(recentLogs.length > 0, 'Should have at least 1 logged notification');
  assert.strictEqual(recentLogs[0].sender_phone, '14155550101');
  assert.strictEqual(recentLogs[0].status, 'sent');
  console.log('  ✅ Notification logging passed');

  console.log('\n🎉 ALL CAMPAIGN & NOTIFIER TESTS PASSED!\n');
  process.exit(0);
}

runCampaignTests().catch((err) => {
  console.error('❌ Tests failed:', err);
  process.exit(1);
});
