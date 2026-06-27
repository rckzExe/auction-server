const express   = require('express');
const admin     = require('firebase-admin');
const WebSocket = require('ws');

const app = express();
app.use(express.json());

admin.initializeApp({
  credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
  databaseURL: 'https://auction-app-4e98f-default-rtdb.firebaseio.com'
});
const db = admin.database();

const connections    = {};
const processed      = new Set();
const processedChats = new Set();
const giftBuffer     = {};
const vouchCooldown  = {};
const FLUSH_DELAY    = 50;

function safeKey(str) {
  return str.replace(/[.#$[\]]/g, '_');
}

function addToBuffer(owner, user, rawUser, amount, photo) {
  const key = owner + '_' + user;
  if (!giftBuffer[key]) {
    giftBuffer[key] = { name: rawUser, score: 0, photoUrl: photo || '', timeout: null };
  }
  giftBuffer[key].score += amount;
  if (photo) giftBuffer[key].photoUrl = photo;
  clearTimeout(giftBuffer[key].timeout);
  giftBuffer[key].timeout = setTimeout(async function() {
    const data = giftBuffer[key];
    delete giftBuffer[key];
    try {
      await db.ref('auctions/' + owner + '/players/' + user).transaction(function(cur) {
        if (!cur) return { name: data.name, score: data.score, photoUrl: data.photoUrl };
        return Object.assign({}, cur, { score: (cur.score || 0) + data.score, photoUrl: data.photoUrl || cur.photoUrl });
      });
      console.log('✅ [' + owner + '] ' + data.name + ' +' + data.score);
    } catch (e) {
      console.error('❌ Firebase error:', e.message);
    }
  }, FLUSH_DELAY);
}

async function handleGift(safeUsername, data) {
  try {
    const common = data.common || {};
    const msgId  = common.msgId || data.msgId;
    if (!msgId) return;

    // Dedup on msgId first
    if (processed.has(msgId)) return;
    processed.add(msgId);
    setTimeout(function() { processed.delete(msgId); }, 15000);

    // For streak gifts (giftType=1, held down gifts like roses):
    // EulerStream sends multiple messages with same groupId
    // Only process when repeatEnd=1 (final count)
    // For single tap gifts (giftType=2): always process
    const giftTypeVal = data.giftType || (data.giftDetails && data.giftDetails.giftType) || 0;
    const repeatEnd   = data.repeatEnd;
    if (giftTypeVal === 1 && (repeatEnd === 0 || repeatEnd === false)) return;

    // User info
    const userObj  = data.user || {};
    const rawUser  = userObj.uniqueId || data.uniqueId || 'unknown';
    const user     = safeKey(rawUser);

    // Profile picture is at data.user.profilePicture.url[0]
    const picObj   = userObj.profilePicture || {};
    const picUrls  = picObj.url || [];
    const photo    = picUrls[0] || '';

    // Gift details are at data.giftDetails
    const details      = data.giftDetails || {};
    const giftName     = (details.giftName || '').toLowerCase();
    const diamondCount = details.diamondCount || 0;
    const repeatCount  = data.repeatCount || 1;

    const snap    = await db.ref('auctions/' + safeUsername).once('value');
    const auction = snap.val();
    if (!auction || !auction.active) return;
    if (auction.snipeEndTime && Date.now() > auction.snipeEndTime) return;

    // Calculate value: diamondCount per gift × repeat count
    const value = (diamondCount > 0 ? diamondCount : 1) * repeatCount;

    console.log('🎁 ' + rawUser + ' | ' + giftName + ' x' + repeatCount + ' | ' + diamondCount + ' diamonds each | = ' + value + ' coins');
    addToBuffer(safeUsername, user, rawUser, value, photo);
  } catch (e) {
    console.error('❌ Gift error:', e.message);
  }
}

async function handleChat(safeUsername, data) {
  try {
    const common = data.common || {};
    const msgId  = common.msgId || data.msgId;
    if (!msgId) return;
    if (processedChats.has(msgId)) return;
    processedChats.add(msgId);
    setTimeout(function() { processedChats.delete(msgId); }, 5000);

    const message  = (data.comment || '').toLowerCase();
    const userObj  = data.user || {};
    const rawUser  = userObj.uniqueId || data.uniqueId || '';
    const user     = safeKey(rawUser);

    const snap    = await db.ref('auctions/' + safeUsername).once('value');
    const auction = snap.val();
    if (!auction || !auction.active) return;

    const words     = auction.vouchWords || [];
    const triggered = words.some(function(w) {
      return typeof w === 'string' && message.includes(w.toLowerCase());
    });
    if (!triggered) return;

    const playersSnap = await db.ref('auctions/' + safeUsername + '/players').once('value');
    const players     = playersSnap.val() || {};
    let top = null;
    Object.values(players).forEach(function(p) {
      if (!top || p.score > top.score) top = p;
    });

    if (!top || !top.name || !rawUser) return;
    if (top.name.toLowerCase() !== rawUser.toLowerCase()) return;

    const coolKey = safeUsername + '_' + user;
    if (vouchCooldown[coolKey]) return;
    vouchCooldown[coolKey] = true;
    setTimeout(function() { delete vouchCooldown[coolKey]; }, 3000);

    if (auction.vouchedUsers && auction.vouchedUsers[user]) return;

    await db.ref('users/' + safeUsername + '/vouches').transaction(function(v) { return (v || 0) + 1; });
    await db.ref('auctions/' + safeUsername + '/vouchedUsers/' + user).set(true);
    await db.ref('auctions/' + safeUsername + '/lastVouch').set({ user: top.name, time: Date.now() });
    console.log('💬 WORD VOUCH from ' + top.name);
  } catch (e) {
    console.error('❌ Chat error:', e.message);
  }
}

function disconnectSafe(safeUsername) {
  // Clear rawUsernames first so the close handler doesn't auto-reconnect
  delete rawUsernames[safeUsername];
  try { const ws = connections[safeUsername]; if (ws) ws.close(); } catch (e) {}
  delete connections[safeUsername];
}

// Track raw usernames for reconnect
const rawUsernames = {};

function connectEuler(safeUsername, rawUsername, isReconnect) {
  const apiKey = process.env.SIGN_API_KEY || '';
  const url    = 'wss://ws.eulerstream.com?uniqueId=' + encodeURIComponent(rawUsername) + '&apiKey=' + encodeURIComponent(apiKey);

  rawUsernames[safeUsername] = rawUsername;

  if (!isReconnect) console.log('🚀 Connecting via EulerStream WS: ' + rawUsername);
  else console.log('♻️ Reconnecting: ' + rawUsername);

  const ws = new WebSocket(url);
  connections[safeUsername] = ws;

  ws.on('open', function() {
    console.log('✅ Connected: ' + rawUsername);
    // Send a ping every 30s to keep the connection alive
    ws._pingInterval = setInterval(function() {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 30000);
  });

  ws.on('close', function(c, r) {
    var reason = r ? r.toString() : '';
    console.log('⚠️ [' + safeUsername + '] WS closed: ' + c + ' ' + reason);
    if (ws._pingInterval) clearInterval(ws._pingInterval);
    delete connections[safeUsername];
    // 4404 = user not live — wait for manual reconnect from panel
    if (c === 4404) {
      console.log('ℹ️ [' + safeUsername + '] User is not live — stopping reconnect');
      delete rawUsernames[safeUsername];
      return;
    }
    // 4429 = rate limit hit — stop hammering, wait 60s then retry once
    if (c === 4429) {
      console.log('⏳ [' + safeUsername + '] Rate limited — waiting 60s before retry');
      setTimeout(function() {
        if (!connections[safeUsername] && rawUsernames[safeUsername]) {
          console.log('🔄 Rate limit retry: ' + rawUsernames[safeUsername]);
          connectEuler(safeUsername, rawUsernames[safeUsername], true);
        }
      }, 60000);
      return;
    }
    // Auto-reconnect for all other drops (network issues, 1006, etc)
    if (rawUsernames[safeUsername]) {
      console.log('🔄 Auto-reconnecting ' + rawUsername + ' in 3s...');
      setTimeout(function() {
        if (!connections[safeUsername] && rawUsernames[safeUsername]) {
          connectEuler(safeUsername, rawUsernames[safeUsername], true);
        }
      }, 3000);
    }
  });

  ws.on('error', function(e) {
    console.error('❌ [' + safeUsername + '] WS error:', e.message);
    delete connections[safeUsername];
  });

  ws.on('message', function(raw) {
    try {
      const msg   = JSON.parse(raw);
      const items = msg.messages || [msg];
      items.forEach(function(item) {
        const type = item.type || item.event || '';
        const data = item.data || item;
        if (type === 'WebcastGiftMessage')  handleGift(safeUsername, data);
        else if (type === 'WebcastChatMessage') handleChat(safeUsername, data);
      });
    } catch (e) {
      console.error('❌ Parse error:', e.message);
    }
  });

  return ws;
}

app.post('/connect', async function(req, res) {
  const rawUsername = req.body.username;
  console.log('📥 /connect hit with:', rawUsername);
  if (!rawUsername) return res.status(400).send('Missing username');

  const safeUsername = safeKey(rawUsername);
  if (connections[safeUsername]) { console.log('♻️ Replacing:', rawUsername); disconnectSafe(safeUsername); }

  try {
    const ws = connectEuler(safeUsername, rawUsername);
    await new Promise(function(resolve, reject) {
      const t = setTimeout(function() { reject(new Error('Timeout')); }, 10000);
      ws.once('open',  function()  { clearTimeout(t); resolve(); });
      ws.once('error', function(e) { clearTimeout(t); reject(e); });
      ws.once('close', function(c) { clearTimeout(t); reject(new Error('Closed: ' + c)); });
    });
    res.send('Connected');
  } catch (err) {
    console.error('❌ Failed:', err.message);
    disconnectSafe(safeUsername);
    res.status(500).send('Failed: ' + err.message);
  }
});

app.post('/disconnect', function(req, res) {
  const rawUsername = req.body.username;
  if (!rawUsername) return res.status(400).send('Missing username');
  disconnectSafe(safeKey(rawUsername));
  console.log('⛔ Disconnected:', rawUsername);
  res.send('Disconnected');
});

app.get('/health',           function(req, res) { res.json({ status: 'ok', connections: Object.keys(connections).length }); });
app.get('/overlay-password', function(req, res) { res.json({ password: 'rckz2026' }); });

process.on('unhandledRejection', function(r) { console.error('⚠️ Unhandled:', r && r.message || r); });
process.on('uncaughtException',  function(e) { console.error('⚠️ Uncaught:',  e && e.message || e); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log('🌐 Server running on port ' + PORT); });
