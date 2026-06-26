const express = require('express');
const admin   = require('firebase-admin');
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
const connections    = {};   // safeUsername -> WebSocket
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
  const key = `${owner}_${user}`;
  if (!giftBuffer[key]) {
    giftBuffer[key] = { name: rawUser, score: 0, photoUrl: photo || '', timeout: null };
  }
  giftBuffer[key].score += amount;
  clearTimeout(giftBuffer[key].timeout);
  giftBuffer[key].timeout = setTimeout(async () => {
    const data = giftBuffer[key];
    delete giftBuffer[key];
    try {
      await db.ref(`auctions/${owner}/players/${user}`).transaction(cur => {
        if (!cur) return { name: data.name, score: data.score, photoUrl: data.photoUrl };
        return { ...cur, score: (cur.score || 0) + data.score };
      });
      console.log(`✅ [${owner}] ${data.name} +${data.score}`);
    } catch (e) {
      console.error('❌ Firebase error:', e.message);
    }
  }, FLUSH_DELAY);
}

// ── DISCONNECT ──
function disconnectSafe(safeUsername) {
  try {
    const ws = connections[safeUsername];
    if (ws) ws.close();
  } catch (e) {}
  delete connections[safeUsername];
}

// ── CONNECT via EulerStream WebSocket ──
function connectEuler(safeUsername, rawUsername) {
  const apiKey = process.env.SIGN_API_KEY;
  const url = `wss://ws.eulerstream.com?uniqueId=${encodeURIComponent(rawUsername)}&apiKey=${encodeURIComponent(apiKey)}`;

  console.log(`🚀 Connecting via EulerStream WS: ${rawUsername}`);

  const ws = new WebSocket(url);
  connections[safeUsername] = ws;

  ws.on('open', () => {
    console.log(`✅ Connected: ${rawUsername}`);
  });

  ws.on('close', (code, reason) => {
    console.log(`⚠️ [${safeUsername}] WS closed: ${code} ${reason}`);
    delete connections[safeUsername];
  });

  ws.on('error', (err) => {
    console.error(`❌ [${safeUsername}] WS error:`, err.message);
    delete connections[safeUsername];
  });

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw);
      // EulerStream wraps events in a messages array
      const messages = msg.messages || [msg];

      for (const item of messages) {
        const event = item.type || item.event;
        const data  = item.data || item;
        await handleEvent(safeUsername, event, data);
      }
  } catch (e) {
    console.error('❌ Event error:', e.message);
  }
}

async function handleEvent(safeUsername, event, data) {
  try {
      // ── GIFT ──
      if (event === 'WebcastGiftMessage' || event === 'gift') {
        const id = data.msgId || `${data.userId}-${data.giftId}-${Date.now()}`;
        if (processed.has(id)) return;
        processed.add(id);
        setTimeout(() => processed.delete(id), 5000);

        const rawUser = data.uniqueId || data.user?.uniqueId || 'unknown';
        const user = safeKey(rawUser);

        const snap = await db.ref(`auctions/${safeUsername}`).once('value');
        const auction = snap.val();
        if (!auction || !auction.active) return;
        if (auction.snipeEndTime && Date.now() > auction.snipeEndTime) return;

        let value = 0;
        const giftName = (data.giftName || data.gift?.name || '').toLowerCase();
        const repeat = data.repeatCount || data.repeatEnd ? (data.repeatCount || 1) : 1;

        if (giftName.includes('rose') || giftName.includes('heart me')) {
          value = repeat;
        } else {
          const giftValues = { 5655: 5, 5760: 30, 7934: 100 };
          const baseValue = Object.prototype.hasOwnProperty.call(giftValues, data.giftId)
            ? giftValues[data.giftId] : (data.diamondCount || 1);
          value = baseValue * repeat;
        }

        if (data.giftType === 1) {
          if (!data.repeatEnd) return;
          lastStreak[user] = { time: Date.now(), amount: value };
        } else {
          const last = lastStreak[user];
          if (last && value === 1 && (Date.now() - last.time < 1200)) return;
        }

        addToBuffer(safeUsername, user, rawUser, value,
          data.user?.profilePictureUrl || data.profilePictureUrl || '');
      }

      // ── CHAT / VOUCH ──
      if (event === 'WebcastChatMessage' || event === 'chat') {
        const message = (data.comment || '').toLowerCase();
        const id = data.msgId || `${data.userId}-${Date.now()}`;
        if (processedChats.has(id)) return;
        processedChats.add(id);
        setTimeout(() => processedChats.delete(id), 5000);

        const rawUser = data.uniqueId || data.user?.uniqueId || '';
        const user = safeKey(rawUser);

        const snap = await db.ref(`auctions/${safeUsername}`).once('value');
        const auction = snap.val();
        if (!auction || !auction.active) return;

        const words = auction.vouchWords || [];
        const triggered = words.some(w => typeof w === 'string' && message.includes(w.toLowerCase()));
        if (!triggered) return;

        const playersSnap = await db.ref(`auctions/${safeUsername}/players`).once('value');
        const players = playersSnap.val() || {};
        let top = null;
        Object.values(players).forEach(p => { if (!top || p.score > top.score) top = p; });

        if (!top || !top.name || !rawUser) return;
        if (top.name.toLowerCase() !== rawUser.toLowerCase()) return;

        const coolKey = `${safeUsername}_${user}`;
        if (vouchCooldown[coolKey]) return;
        vouchCooldown[coolKey] = true;
        setTimeout(() => delete vouchCooldown[coolKey], 3000);

        if (auction.vouchedUsers && auction.vouchedUsers[user]) return;

        await db.ref(`users/${safeUsername}/vouches`).transaction(v => (v || 0) + 1);
        await db.ref(`auctions/${safeUsername}/vouchedUsers/${user}`).set(true);
        await db.ref(`auctions/${safeUsername}/lastVouch`).set({ user: top.name, time: Date.now() });
        console.log(`💬 WORD VOUCH from ${top.name}`);
      }

  } catch (e) {
    console.error('❌ Event error:', e.message);
  }
}

// ── ENDPOINTS ──
app.post('/connect', async (req, res) => {
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

    // Wait up to 10s for connection to open
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000);
      ws.once('open', () => { clearTimeout(timeout); resolve(); });
      ws.once('error', (err) => { clearTimeout(timeout); reject(err); });
      ws.once('close', (code) => { clearTimeout(timeout); reject(new Error(`Closed with code ${code}`)); });
    });

    res.send('Connected');
  } catch (err) {
    console.error('❌ Failed to connect:', err.message);
    disconnectSafe(safeUsername);
    res.status(500).send('Failed to connect: ' + err.message);
  }
});

app.post('/disconnect', (req, res) => {
  const rawUsername = req.body.username;
  if (!rawUsername) return res.status(400).send('Missing username');
  disconnectSafe(safeKey(rawUsername));
  console.log('⛔ Disconnected:', rawUsername);
  res.send('Disconnected');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', connections: Object.keys(connections).length });
});

app.get('/overlay-password', (req, res) => {
  res.json({ password: 'rckz2026' });
});

process.on('unhandledRejection', (r) => console.error('⚠️ Unhandled:', r?.message || r));
process.on('uncaughtException', (e) => console.error('⚠️ Uncaught:', e?.message || e));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Server running on port ${PORT}`));
