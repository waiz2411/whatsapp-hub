const assert = require('assert');

process.env.MAIN_PHONE_NUMBER = '923473201427';
process.env.PORT = '3004';
process.env.OUTREACH_MIN_DELAY_MINUTES = '10';
process.env.OUTREACH_MAX_DELAY_MINUTES = '15';

const database = require('../src/database');
const { parseDailyLeadList, personalizeOutreachMessage, OutreachManager } = require('../src/outreachManager');

async function runOutreachTests() {
  console.log('🧪 Starting Dedicated Per-Number Daily Outreach Tests...\n');

  await database.init();

  // Test 1: Lead List Parsing (Phone & Name)
  console.log('Test 1: parseDailyLeadList');
  const rawList = `
Phone, Name
+92 300 1234567, Ali Khan
14155550199, "Sarah Connor"
+44 7911 123456, John Smith
971501234567, 
invalid-phone, Bob
923001234567, Duplicate Ali
`;

  const parsed = parseDailyLeadList(rawList);
  assert.strictEqual(parsed.length, 4, 'Should parse 4 valid unique leads');
  assert.strictEqual(parsed[0].phone, '923001234567');
  assert.strictEqual(parsed[0].name, 'Ali Khan');
  assert.strictEqual(parsed[1].phone, '14155550199');
  assert.strictEqual(parsed[1].name, 'Sarah Connor');
  assert.strictEqual(parsed[2].phone, '447911123456');
  assert.strictEqual(parsed[2].name, 'John Smith');
  assert.strictEqual(parsed[3].phone, '971501234567');
  assert.strictEqual(parsed[3].name, '');
  console.log('  ✅ parseDailyLeadList correctly extracts numbers, cleans digits, and preserves names');

  // Test 2: Message Personalization with {name}
  console.log('Test 2: personalizeOutreachMessage');
  const template = 'Hello {name}! Reaching out regarding your inquiry for {phone}.';
  const msg1 = personalizeOutreachMessage(template, parsed[0]);
  assert.strictEqual(msg1, 'Hello Ali Khan! Reaching out regarding your inquiry for 923001234567.');

  const msg2 = personalizeOutreachMessage(template, parsed[3], 'there');
  assert.strictEqual(msg2, 'Hello there! Reaching out regarding your inquiry for 971501234567.');
  console.log('  ✅ Template personalization correctly substitutes {name} and {phone}');

  // Test 3: Per-Account Queue Isolation in Database
  console.log('Test 3: Per-Account Lead Queue Isolation');
  // Clear any existing leads for test accounts 1 & 2
  await database.clearPendingOutreachLeads(1);
  await database.clearPendingOutreachLeads(2);

  // Add 2 leads to Account 1
  await database.addOutreachLeads(1, [
    { phone: '14155550111', name: 'Lead One' },
    { phone: '14155550112', name: 'Lead Two' },
  ]);

  // Add 1 lead to Account 2
  await database.addOutreachLeads(2, [
    { phone: '14155550222', name: 'Lead Three' },
  ]);

  const acc1Summary = await database.getOutreachQueueSummary(1);
  assert.strictEqual(acc1Summary.pending, 2, 'Account 1 should have 2 pending leads');

  const acc2Summary = await database.getOutreachQueueSummary(2);
  assert.strictEqual(acc2Summary.pending, 1, 'Account 2 should have 1 pending lead');

  const next1 = await database.getNextPendingOutreachLead(1);
  assert.strictEqual(next1.phone_number, '14155550111');
  assert.strictEqual(next1.account_id, 1);

  const next2 = await database.getNextPendingOutreachLead(2);
  assert.strictEqual(next2.phone_number, '14155550222');
  assert.strictEqual(next2.account_id, 2);
  console.log('  ✅ Account queues are strictly isolated per connected number');

  // Test 4: 10-15 Minute Delay Setting & Countdown Calculation
  console.log('Test 4: 10 to 15-Minute Pacing Configuration & Persistence');
  const delayMinutes = 12.5; // within 10 to 15 min
  const nextRunAt = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString();

  await database.updateOutreachAccountState(1, {
    next_run_at: nextRunAt,
    min_delay_minutes: 10,
    max_delay_minutes: 15,
  });

  const state1 = await database.getOutreachAccountState(1);
  assert.strictEqual(state1.min_delay_minutes, 10);
  assert.strictEqual(state1.max_delay_minutes, 15);
  assert(Date.parse(state1.next_run_at) > Date.now());

  const remainingSeconds = Math.ceil((Date.parse(state1.next_run_at) - Date.now()) / 1000);
  assert(remainingSeconds > 600 && remainingSeconds <= 900, 'Remaining countdown should be between 10 and 15 minutes');
  console.log(`  ✅ 10-15 minute pacing persisted in SQLite with live countdown (${remainingSeconds}s remaining)`);

  // Test 5: OutreachManager controls (Pause, Resume, Clear)
  console.log('Test 5: OutreachManager Controls');
  const mockWa = {
    isAccountConnected: () => true,
    getAccountStates: () => [{ id: 1, name: 'Business #1', phoneNumber: '14155550001' }],
    sendMessageToPhone: async () => ({ id: 1 }),
  };
  const manager = new OutreachManager(mockWa);

  // Test Pause
  await manager.pauseAccount(1);
  let status = await manager.getAccountStatus(1);
  assert.strictEqual(status.isActive, false);
  assert.strictEqual(status.status, 'paused');

  // Test Resume
  await manager.resumeAccount(1);
  status = await manager.getAccountStatus(1);
  assert.strictEqual(status.isActive, true);

  // Test Clear Queue
  await manager.clearQueue(1);
  status = await manager.getAccountStatus(1);
  assert.strictEqual(status.summary.pending, 0);
  console.log('  ✅ Pause, Resume, and Clear Queue work as expected');

  console.log('\n🎉 ALL DEDICATED OUTREACH TESTS PASSED!\n');
  process.exit(0);
}

runOutreachTests().catch((err) => {
  console.error('❌ Tests failed:', err);
  process.exit(1);
});
