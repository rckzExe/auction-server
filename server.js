const express  = require('express');
const admin    = require('firebase-admin');
const WebSocket = require('ws');

const app = express();
app.use(express.json());

// ── FIREBASE ──
admin.initializeApp({
  credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
  databaseURL: 'https://auction-app-4e98f-default-rtdb.firebaseio.com'
});
const db = admin.database();

// ── STATE ──
const connections    = {};
const processed      = new Set();
const processedChats = new Set();
const lastStreak     = {};
const giftBuffer     = {};
const vouchCooldown  = {};
const FLUSH_DELAY    = 250;

function safeKey(str) {
  return str.replace(/[.#$[\]]/g, '_');
}

// ── BUFFER ──
function addToBuffer(owner, user, rawUser, amount, photo) {
  const key = owner + '_' + user;
  if (!giftBuffer[key]) {
    giftBuffer[key] = { name: rawUser, score: 0, photoUrl: photo || '', timeout: null };
  }
  giftBuffer[key].score += amount;
  clearTimeout(giftBuffer[key].timeout);
  giftBuffer[key].timeout = setTimeout(async () => {
    const data = giftBuffer[key];
    delete giftBuffer[key];
    try {
      await db.ref('auctions/' + owner + '/players/' + user).transaction(cur => {
        if (!cur) return { name: data.name, score: data.score, photoUrl: data.photoUrl };
        return Object.assign({}, cur, { score: (cur.score || 0) + data.score });
      });
      console.log('✅ [' + owner + '] ' + data.name + ' +' + data.score);
    } catch (e) {
      console.error('❌ Firebase error:', e.message);
    }
  }, FLUSH_DELAY);
}

// ── HANDLE GIFT ──
async function handleGift(safeUsername, data) {
  try {
    const id = data.msgId || (data.userId + '-' + data.giftId + '-' + Date.now());
    if (processed.has(id)) return;
    processed.add(id);
    setTimeout(() => processed.delete(id), 5000);

    const rawUser = data.uniqueId || (data.user && data.user.uniqueId) || 'unknown';
    const user = safeKey(rawUser);

    const snap = await db.ref('auctions/' + safeUsername).once('value');
    const auction = snap.val();
    if (!auction || !auction.active) return;
    if (auction.snipeEndTime && Date.now() > auction.snipeEndTime) return;

    let value = 0;
    const giftName = (data.giftName || (data.gift && data.gift.name) || '').toLowerCase();
    const repeat = data.repeatCount || 1;

    if (giftName.includes('rose') || giftName.includes('heart me')) {
      value = repeat;
    } else {
      const giftValues = { 5655: 5, 5760: 30, 7934: 100 };
      const giftId = data.giftId;
      const baseValue = Object.prototype.hasOwnProperty.call(giftValues, giftId)
        ? giftValues[giftId] : (data.diamondCount || 1);
      value = baseValue * repeat;
    }

    if (data.giftType === 1) {
      if (!data.repeatEnd) return;
      lastStreak[user] = { time: Date.now(), amount: value };
    } else {
      const last = lastStreak[user];
      if (last && value === 1 && (Date.now() - last.time < 1200)) return;
    }

    const photo = (data.user && data.user.profilePictureUrl) || data.profilePictureUrl || '';
    addToBuffer(safeUsername, user, rawUser, value, photo);
  } catch (e) {
    console.error('❌ Gift error:', e.message);
  }
}

// ── HANDLE CHAT ──
async function handleChat(safeUsername, data) {
  try {
    const message = (data.comment || '').toLowerCase();
    const id = data.msgId || (data.userId + '-' + Date.now());
    if (processedChats.has(id)) return;
    processedChats.add(id);
    setTimeout(() => processedChats.delete(id), 5000);

    const rawUser = data.uniqueId || (data.user && data.user.uniqueId) || '';
    const user = safeKey(rawUser);

    const snap = await db.ref('auctions/' + safeUsername).once('value');
    const auction = snap.val();
    if (!auction || !auction.active) return;

    const words = auction.vouchWords || [];
    const triggered = words.some(function(w) {
      return typeof w === 'string' && message.includes(w.toLowerCase());
    });
    if (!triggered) return;

    const playersSnap = await db.ref('auctions/' + safeUsername + '/players').once('value');
    const players = playersSnap.val() || {};
    let top = null;
    Object.values(players).forEach(function(p) {
      if (!top || p.score > top.score) top = p;
    });

    if (!top || !top.name || !rawUser) return;
    if (top.name.toLowerCase() !== rawUser.toLowerCase()) return;

    const coolKey = safeUsername + '_' + user;
    if (vouchCooldown[coolKey]) return;
    vouchCooldown[coolKey] = true;
    setTimeout(() => delete vouchCooldown[coolKey], 3000);

    if (auction.vouchedUsers && auction.vouchedUsers[user]) return;

    await db.ref('users/' + safeUsername + '/vouches').transaction(function(v) { return (v || 0) + 1; });
    await db.ref('auctions/' + safeUsername + '/vouchedUsers/' + user).set(true);
    await db.ref('auctions/' + safeUsername + '/lastVouch').set({ user: top.name, time: Date.now() });
    console.log('💬 WORD VOUCH from ' + top.name);
  } catch (e) {
    console.error('❌ Chat error:', e.message);
  }
}

// ── DISCONNECT ──
function disconnectSafe(safeUsername) {
  try {
    const ws = connections[safeUsername];
    if (ws) ws.close();
  } catch (e) {}
  delete connections[safeUsername];
}

// ── CONNECT ──
function connectEuler(safeUsername, rawUsername) {
  const apiKey = process.env.SIGN_API_KEY || '';
  const url = 'wss://ws.eulerstream.com?uniqueId=' + encodeURIComponent(rawUsername) + '&apiKey=' + encodeURIComponent(apiKey);

  console.log('🚀 Connecting via EulerStream WS: ' + rawUsername);

  const ws = new WebSocket(url);
  connections[safeUsername] = ws;

  ws.on('open', function() {
    console.log('✅ Connected: ' + rawUsername);
  });

  ws.on('close', function(code, reason) {
    console.log('⚠️ [' + safeUsername + '] WS closed: ' + code + ' ' + reason);
    delete connections[safeUsername];
  });

  ws.on('error', function(err) {
    console.error('❌ [' + safeUsername + '] WS error:', err.message);
    delete connections[safeUsername];
  });

  ws.on('message', function(raw) {
    try {
      const msg = JSON.parse(raw);
      // EulerStream sends { messages: [ { type, data } ] }
      const items = msg.messages || [msg];
      items.forEach(function(item) {
        const type = item.type || item.event || '';
        const data = item.data || item;
        if (type === 'WebcastGiftMessage' || type === 'gift') {
          handleGift(safeUsername, data);
        } else if (type === 'WebcastChatMessage' || type === 'chat') {
          handleChat(safeUsername, data);
        }
      });
    } catch (e) {
      console.error('❌ Message parse error:', e.message);
    }
  });

  return ws;
}

// ── ENDPOINTS ──
app.post('/connect', async function(req, res) {
  const rawUsername = req.body.username;
  console.log('📥 /connect hit with:', rawUsername);
  if (!rawUsername) return res.status(400).send('Missing username');

  const safeUsername = safeKey(rawUsername);
  if (connections[safeUsername]) {
    console.log('♻️ Replacing:', rawUsername);
    disconnectSafe(safeUsername);
  }

  try {
    const ws = connectEuler(safeUsername, rawUsername);

    await new Promise(function(resolve, reject) {
      const timeout = setTimeout(function() { reject(new Error('Connection timeout')); }, 10000);
      ws.once('open', function() { clearTimeout(timeout); resolve(); });
      ws.once('error', function(err) { clearTimeout(timeout); reject(err); });
      ws.once('close', function(code) { clearTimeout(timeout); reject(new Error('Closed: ' + code)); });
    });

    res.send('Connected');
  } catch (err) {
    console.error('❌ Failed to connect:', err.message);
    disconnectSafe(safeUsername);
    res.status(500).send('Failed to connect: ' + err.message);
  }
});

app.post('/disconnect', function(req, res) {
  const rawUsername = req.body.username;
  if (!rawUsername) return res.status(400).send('Missing username');
  disconnectSafe(safeKey(rawUsername));
  console.log('⛔ Disconnected:', rawUsername);
  res.send('Disconnected');
});

app.get('/health', function(req, res) {
  res.json({ status: 'ok', connections: Object.keys(connections).length });
});

app.get('/overlay-password', function(req, res) {
  res.json({ password: 'rckz2026' });
});

process.on('unhandledRejection', function(r) { console.error('⚠️ Unhandled:', r && r.message || r); });
process.on('uncaughtException', function(e) { console.error('⚠️ Uncaught:', e && e.message || e); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log('🌐 Server running on port ' + PORT); });
