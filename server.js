const express  = require('express');
const admin    = require('firebase-admin');
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
const FLUSH_DELAY    = 250;

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

function getPhoto(data) {
  const u = data.user || data.userInfo || data.sender || {};

  function fromImg(img) {
    if (!img) return "";
    if (typeof img === "string") return img;
    if (Array.isArray(img.urlList)) return img.urlList[0] || "";
    if (Array.isArray(img.url_list)) return img.url_list[0] || "";
    if (Array.isArray(img.urls)) return img.urls[0] || "";
    if (img.url) return img.url;
    if (img.uri) return img.uri;
    return "";
  }

  return (
    data.profilePictureUrl ||
    data.profile_picture_url ||
    fromImg(data.avatarThumb) ||
    fromImg(data.avatarMedium) ||
    fromImg(data.avatarLarge) ||
    fromImg(u.avatarThumb) ||
    fromImg(u.avatarMedium) ||
    fromImg(u.avatarLarge) ||
    fromImg(u.avatar_thumb) ||
    fromImg(u.avatar_medium) ||
    fromImg(u.avatar_large) ||
    u.profilePictureUrl ||
    u.profile_picture_url ||
    ""
  );
}

async function handleGift(safeUsername, item) {
  try {
    const data = item.data || item.payload || item.message || item;
    const common = data.common || item.common || {};
    const gift = data.gift || data.giftInfo || data.giftDetails || data;

    const rawUser =
      data.user?.uniqueId ||
      data.userInfo?.uniqueId ||
      data.sender?.uniqueId ||
      data.uniqueId ||
      item.user?.uniqueId ||
      "unknown";

    const user = safeKey(rawUser);
    const photo = getPhoto(data);

    const giftId = String(
      data.giftId ||
      data.gift_id ||
      gift.id ||
      gift.giftId ||
      gift.gift_id ||
      ""
    );

    const giftName = String(
      data.giftName ||
      data.gift_name ||
      gift.name ||
      gift.giftName ||
      common.describe ||
      ""
    ).toLowerCase();

    const repeatCount = Number(
      data.repeatCount ||
      data.repeat_count ||
      gift.repeatCount ||
      gift.repeat_count ||
      1
    );

    const id =
      common.msgId ||
      data.msgId ||
      data.messageId ||
      data.eventId ||
      data.id ||
      `${rawUser}_${giftId || giftName}_${repeatCount}_${Math.floor(Date.now() / 3)}`;

    const dedupeKey = `${safeUsername}_${id}`;
    if (processed.has(dedupeKey)) return;
    processed.add(dedupeKey);
    setTimeout(() => processed.delete(dedupeKey), 60000);

    const snap = await db.ref("auctions/" + safeUsername).once("value");
    const auction = snap.val();
    if (!auction || !auction.active) return;
    if (auction.snipeEndTime && Date.now() > auction.snipeEndTime) return;

    const diamondCount = Number(
      data.diamondCount ||
      data.diamond_count ||
      gift.diamondCount ||
      gift.diamond_count ||
      gift.diamonds ||
      gift.cost ||
      gift.price ||
      0
    );

    const knownGiftValues = {
      "5655": 5,
      "5760": 30,
      "7934": 100
    };

    let value = 0;

    if (knownGiftValues[giftId]) {
      value = knownGiftValues[giftId] * repeatCount;
    } else if (diamondCount > 0) {
      value = diamondCount * repeatCount;
    } else {
      value = repeatCount;
    }

    console.log(`🎁 COUNTED ${rawUser} ${giftName} id=${giftId} x${repeatCount} diamonds=${diamondCount} value=${value}`);

    addToBuffer(safeUsername, user, rawUser, value, photo);
  } catch (e) {
    console.error("❌ Gift error:", e.message);
  }
}

async function handleChat(safeUsername, data) {
  try {
    const common = data.common || {};
    const msgId = common.msgId || data.msgId;
    if (!msgId) return;
    if (processedChats.has(msgId)) return;
    processedChats.add(msgId);
    setTimeout(function() { processedChats.delete(msgId); }, 5000);

    const message = (data.comment || '').toLowerCase();
    const rawUser = (data.user && data.user.uniqueId) || data.uniqueId || '';
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
  try {
    const ws = connections[safeUsername];
    if (ws) ws.close();
  } catch (e) {}
  delete connections[safeUsername];
}

function connectEuler(safeUsername, rawUsername) {
  const apiKey = process.env.SIGN_API_KEY || '';
  const url = 'wss://ws.eulerstream.com?uniqueId=' + encodeURIComponent(rawUsername) + '&apiKey=' + encodeURIComponent(apiKey);

  console.log('🚀 Connecting via EulerStream WS: ' + rawUsername);
  const ws = new WebSocket(url);
  connections[safeUsername] = ws;

  ws.on('open', function() { console.log('✅ Connected: ' + rawUsername); });
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
    const items = msg.messages || msg.events || msg.data?.messages || [msg];

    items.forEach(function(item) {
      const eventName = String(
        item.type ||
        item.event ||
        item.method ||
        item.messageType ||
        item.name ||
        item.data?.type ||
        item.data?.event ||
        ''
      ).toLowerCase();

      const data = item.data || item.payload || item.message || item;

      const isGift =
        eventName.includes('gift') ||
        data.gift ||
        data.giftId ||
        data.giftName ||
        data.gift_id;

      const isChat =
        eventName.includes('chat') ||
        eventName.includes('comment') ||
        data.comment;

     if (isGift) {
  handleGift(safeUsername, item);
} else if (isChat) {
  handleChat(safeUsername, data);
}
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
  if (connections[safeUsername]) {
    console.log('♻️ Replacing:', rawUsername);
    disconnectSafe(safeUsername);
  }

  try {
    const ws = connectEuler(safeUsername, rawUsername);
    await new Promise(function(resolve, reject) {
      const t = setTimeout(function() { reject(new Error('Timeout')); }, 10000);
      ws.once('open', function() { clearTimeout(t); resolve(); });
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
