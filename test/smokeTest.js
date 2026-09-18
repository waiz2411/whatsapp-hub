const assert = require('assert');

process.env.MAIN_PHONE_NUMBER = '19998887777';
process.env.PORT = '3001';

const config = require('../src/config');
const database = require('../src/database');

async function runTests() {
  console.log('🧪 Starting Full Chat Web Smoke Tests...\n');

  await database.init();

  const testPhone = '1415' + Math.floor(1000000 + Math.random() * 9000000);

  // Test: Insert back-and-forth conversation
  console.log('Test 1: Recording incoming and outgoing messages in a conversation');
  const incoming = await database.recordMessage({
    accountId: 1,
    leadPhone: testPhone,
    leadName: 'Alice Prospect',
    fromMe: false,
    body: 'Hi, what are your agency rates?',
    timestamp: Date.now() - 10000,
  });
  assert(incoming.id, 'Incoming message should have an ID');

  const outgoing = await database.recordMessage({
    accountId: 1,
    leadPhone: testPhone,
    leadName: 'Alice Prospect',
    fromMe: true,
    body: 'Hello Alice! We start at $500/mo.',
    timestamp: Date.now(),
  });
  assert(outgoing.id, 'Outgoing message should have an ID');
  console.log('  ✅ Conversation recorded successfully');

  // Test: Fetch chats for Account 1
  console.log('Test 2: getChatsForAccount');
  const chats = await database.getChatsForAccount(1);
  assert(chats.length > 0, 'Should return at least 1 chat');
  const aliceChat = chats.find(c => c.lead_phone === testPhone);
  assert(aliceChat, 'Alice chat should exist in Account 1');
  assert.strictEqual(aliceChat.last_message, 'Hello Alice! We start at $500/mo.');
  assert.strictEqual(aliceChat.last_from_me, 1);
  console.log('  ✅ getChatsForAccount returns correct latest message and status');

  // Test: Fetch messages thread
  console.log('Test 3: getChatMessages');
  const thread = await database.getChatMessages(1, testPhone);
  assert.strictEqual(thread.length, 2, 'Thread should have exactly 2 messages');
  assert.strictEqual(thread[0].from_me, 0);
  assert.strictEqual(thread[1].from_me, 1);
  console.log('  ✅ getChatMessages returns chronological thread');

  // Test: Isolation across accounts
  console.log('Test 4: Account Isolation');
  const acc2Chats = await database.getChatsForAccount(2);
  const acc2Alice = acc2Chats.find(c => c.lead_phone === testPhone);
  assert(!acc2Alice, 'Alice chat should NOT appear in Account 2');
  console.log('  ✅ Conversations are properly isolated per business account');

  console.log('\n🎉 ALL FULL CHAT TESTS PASSED!\n');
  process.exit(0);
}

runTests().catch(err => {
  console.error('❌ Tests failed:', err);
  process.exit(1);
});
