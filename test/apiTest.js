const assert = require('assert');
const http = require('http');

process.env.PORT = '3003';
process.env.MAIN_PHONE_NUMBER = '923473201427';
process.env.DEBOUNCE_SECONDS = '3';

const express = require('express');
const config = require('../src/config');
const database = require('../src/database');
const { CampaignManager, parseContactsInput, personalizeMessage } = require('../src/campaignManager');

async function runApiTests() {
  console.log('🧪 Starting Server API Route Verification...\n');

  await database.init();

  const mockWaManager = {
    sockets: new Map(),
    accountStates: new Map([
      [1, { id: 1, status: 'connected', phoneNumber: '923001111111', name: 'Business #1' }],
      [2, { id: 2, status: 'connected', phoneNumber: '923002222222', name: 'Business #2' }],
      [3, { id: 3, status: 'disconnected', phoneNumber: null, name: 'Business #3' }],
      [4, { id: 4, status: 'disconnected', phoneNumber: null, name: 'Business #4' }],
    ]),
    getConnectedAccountIds() {
      return [1, 2];
    },
    isAccountConnected(id) {
      return id === 1 || id === 2;
    },
    getAccountStates() {
      return Array.from(this.accountStates.values());
    },
    async sendMessageToPhone(accId, phone, text, name) {
      return { id: 999, account_id: accId, lead_phone: phone, body: text };
    },
    async broadcastToMain() {
      return true;
    }
  };

  const campaignManager = new CampaignManager(mockWaManager);

  // Setup test Express app with exact same routes
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  app.post('/api/campaigns/preview', (req, res) => {
    const { rawContacts, template, accountIds, fallbackName } = req.body;
    const contacts = parseContactsInput(rawContacts || '');
    const connectedAccounts = mockWaManager.getConnectedAccountIds();
    const targetAccounts = accountIds && accountIds.length > 0 ? accountIds : connectedAccounts;

    const samplePreview = contacts.slice(0, 5).map((c, index) => {
      const assignedAccount = targetAccounts.length > 0 ? targetAccounts[index % targetAccounts.length] : null;
      return {
        phone: c.phone,
        name: c.name,
        assignedAccountId: assignedAccount,
        renderedMessage: personalizeMessage(template || '', c, fallbackName || 'there'),
      };
    });

    res.json({
      totalContacts: contacts.length,
      connectedAccounts,
      targetAccounts,
      samplePreview,
    });
  });

  app.post('/api/campaigns', async (req, res) => {
    try {
      const { name, template, rawContacts, parsedContactsList, accountIds, minDelay, maxDelay, fallbackName } = req.body;
      const campaign = await campaignManager.prepareAndCreateCampaign({
        name,
        template,
        rawContacts,
        parsedContactsList,
        accountIds: accountIds || mockWaManager.getConnectedAccountIds(),
        minDelay,
        maxDelay,
        fallbackName,
      });
      res.json({ success: true, campaign });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/campaigns/:id', async (req, res) => {
    const campaign = await database.getCampaign(parseInt(req.params.id, 10));
    const items = await database.getCampaignItems(parseInt(req.params.id, 10));
    res.json({ campaign, items });
  });

  app.get('/api/notifications/recent', async (req, res) => {
    const logs = await database.getRecentNotifications(50);
    res.json(logs);
  });

  const server = app.listen(3003);

  function request(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: 'localhost',
          port: 3003,
          path,
          method,
          headers: { 'Content-Type': 'application/json' },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode, body: JSON.parse(data) });
            } catch (e) {
              resolve({ status: res.statusCode, body: data });
            }
          });
        }
      );
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  try {
    // 1. Test POST /api/campaigns/preview
    console.log('Test 1: POST /api/campaigns/preview');
    const previewRes = await request('POST', '/api/campaigns/preview', {
      rawContacts: "923001234567, Ali Khan\n14155550199, Sarah Connor\n447911123456, John Smith\n971501234567, Fatima",
      template: "Hello {name}, your phone is {phone}!",
      accountIds: [1, 2],
    });
    assert.strictEqual(previewRes.status, 200);
    assert.strictEqual(previewRes.body.totalContacts, 4);
    assert.strictEqual(previewRes.body.samplePreview[0].assignedAccountId, 1);
    assert.strictEqual(previewRes.body.samplePreview[1].assignedAccountId, 2);
    assert.strictEqual(previewRes.body.samplePreview[0].renderedMessage, "Hello Ali Khan, your phone is 923001234567!");
    console.log('  ✅ Preview endpoint returned correct partitioning & personalized messages');

    // 2. Test POST /api/campaigns (Create Campaign)
    console.log('Test 2: POST /api/campaigns');
    const createRes = await request('POST', '/api/campaigns', {
      name: 'API Test Campaign',
      template: 'Hi {name}! Check this out.',
      rawContacts: "923001111111, Contact 1\n923002222222, Contact 2\n923003333333, Contact 3\n923004444444, Contact 4",
      accountIds: [1, 2],
      minDelay: 6,
      maxDelay: 12,
      fallbackName: 'there',
    });
    assert.strictEqual(createRes.status, 200);
    assert(createRes.body.campaign.id);
    assert.strictEqual(createRes.body.campaign.total_contacts, 4);
    assert.strictEqual(createRes.body.campaign.accountBreakdown[1].total, 2);
    assert.strictEqual(createRes.body.campaign.accountBreakdown[2].total, 2);
    console.log('  ✅ Campaign created with 50/50 partition between account 1 and 2');

    // 3. Test GET /api/campaigns/:id
    console.log('Test 3: GET /api/campaigns/:id');
    const getRes = await request('GET', `/api/campaigns/${createRes.body.campaign.id}`);
    assert.strictEqual(getRes.status, 200);
    assert.strictEqual(getRes.body.items.length, 4);
    assert.strictEqual(getRes.body.items[0].account_id, 1);
    assert.strictEqual(getRes.body.items[1].account_id, 2);
    assert.strictEqual(getRes.body.items[2].account_id, 1);
    assert.strictEqual(getRes.body.items[3].account_id, 2);
    console.log('  ✅ Campaign items correctly fetched with round-robin account assignment');

    // 4. Test GET /api/notifications/recent
    console.log('Test 4: GET /api/notifications/recent');
    const notifRes = await request('GET', '/api/notifications/recent');
    assert.strictEqual(notifRes.status, 200);
    assert(Array.isArray(notifRes.body));
    console.log('  ✅ Notifications recent list endpoint passed');

    console.log('\n🎉 ALL API ENDPOINT TESTS PASSED!\n');
  } finally {
    server.close();
  }
}

runApiTests().catch((err) => {
  console.error('❌ API Test failed:', err);
  process.exit(1);
});
