const express   = require('express');
const admin     = require('firebase-admin');
const WebSocket = require('ws');
const crypto    = require('crypto');
const app = express();
app.use(express.json());

// Your app's windows load as file:// pages, and browsers block
// cross-origin fetch() calls by default unless the server explicitly
// allows it. Without this, EVERY request to /auth-token from
// admin.html/index.html fails silently before it even reaches the
// code above — which is exactly what "Connect does nothing, no
// popup, board frozen" looks like from the app's side.
app.use(function(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
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

// ── STREAK GIFT SAFETY NET ──
// Streakable gifts (giftType===1, e.g. Rose) send repeated messages with
// repeatEnd:false while held, then one final repeatEnd:true message when
// the streak ends. Previously, if that final message never arrived
// (dropped, or TikTok/EulerStream just doesn't always cleanly close out
// very quick single taps), NOTHING ever got through — every message for
// that gift had repeatEnd:false and was silently ignored forever, which
// is exactly why Rose specifically could just stop working.
// This tracks the latest count per (user + gift) and, if no proper
// "streak ended" message shows up within STREAK_TIMEOUT, processes it
// anyway using the last count actually seen — so a real send is never
// lost just because TikTok never told us the streak was "done".
const pendingStreaks = {};
const STREAK_TIMEOUT = 4000;

async function handleGift(safeUsername, data) {
  try {
    const common = data.common || {};
    const msgId  = common.msgId || data.msgId;
    if (!msgId) return;
    if (processed.has(msgId)) return;
    processed.add(msgId);
    setTimeout(function() { processed.delete(msgId); }, 15000);

    const userObj  = data.user || {};
    const rawUser  = userObj.uniqueId || data.uniqueId || 'unknown';
    const user     = safeKey(rawUser);

    const picObj   = userObj.profilePicture || {};
    const picUrls  = picObj.url || [];
    const photo    = picUrls[0] || '';

    const details      = data.giftDetails || {};
    const giftName     = (details.giftName || '').toLowerCase();
    const diamondCount = details.diamondCount || 0;
    const repeatCount  = data.repeatCount || 1;

    const giftTypeVal = data.giftType || (data.giftDetails && data.giftDetails.giftType) || 0;
    const repeatEnd   = data.repeatEnd;

    const snap    = await db.ref('auctions/' + safeUsername).once('value');
    const auction = snap.val();
    if (!auction || !auction.active) return;
    if (auction.snipeEndTime && Date.now() > auction.snipeEndTime) return;

    const value = (diamondCount > 0 ? diamondCount : 1) * repeatCount;
    const giftFilter = auction.spinRoyaleGiftFilter; // only ever set by Spin Royale's panel.js

    if (giftTypeVal === 1 && (repeatEnd === 0 || repeatEnd === false)) {
      // Unchanged, unconditional, exactly as it always was: mid-streak
      // messages never count directly, for every auction, both products.
      //
      // Spin-Royale-only addition layered on top: also arm a fallback
      // timer, so if the real "streak ended" message never arrives, we
      // still count it after a few seconds instead of losing it forever.
      // Gated strictly behind giftFilter, so Auction Board's behavior
      // here is 100% identical to before this file was ever touched.
      if (giftFilter && typeof giftFilter.minValue === 'number') {
        const perGiftValue = diamondCount > 0 ? diamondCount : 1;
        const streakKey = safeUsername + '_' + user + '_' + (details.giftId || giftName);
        if (pendingStreaks[streakKey]) clearTimeout(pendingStreaks[streakKey].timeout);
        pendingStreaks[streakKey] = {
          timeout: setTimeout(function() {
            delete pendingStreaks[streakKey];
            if (perGiftValue < giftFilter.minValue) return;
            console.log('⏱️ [SpinRoyale] streak end never arrived for ' + rawUser + ' | ' + giftName + ' — using last seen count (' + value + ' coins) instead of dropping it');
            addToBuffer(safeUsername, user, rawUser, value, photo);
          }, STREAK_TIMEOUT)
        };
      }
      return;
    }

    if (giftFilter && giftTypeVal === 1) {
      const streakKey = safeUsername + '_' + user + '_' + (details.giftId || giftName);
      if (pendingStreaks[streakKey]) {
        clearTimeout(pendingStreaks[streakKey].timeout);
        delete pendingStreaks[streakKey];
      }
    }

    // ── SPIN ROYALE GIFT FILTER ──
    // Only ever runs when spinRoyaleGiftFilter exists — a field Auction
    // Board never writes or reads, so this is always skipped entirely
    // for Auction Board auctions.
    if (giftFilter && typeof giftFilter.minValue === 'number') {
      const perGiftValue = diamondCount > 0 ? diamondCount : 1;
      // Only counts if a single instance of this gift is worth at least
      // as much as the configured minimum (e.g. Rose selected -> Rose or
      // anything pricier counts, cheaper gifts don't). Bigger gifts add
      // their full, larger value — that's what makes them worth more.
      if (perGiftValue < giftFilter.minValue) {
        console.log('🚫 [SpinRoyale] ' + rawUser + '\'s ' + giftName + ' (' + perGiftValue + ') is below the required ' + giftFilter.minValue + ' — not counted');
        return;
      }
    }

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
    const rawMessage = data.comment || '';
    const message  = rawMessage.toLowerCase();
    const userObj  = data.user || {};
    const rawUser  = userObj.uniqueId || data.uniqueId || '';
    const user     = safeKey(rawUser);
    const snap    = await db.ref('auctions/' + safeUsername).once('value');
    const auction = snap.val();
    if (!auction || !auction.active) return;
    if (rawMessage && rawUser && auction.players && auction.players[user]) {
      db.ref('auctions/' + safeUsername + '/chatMessages/' + user)
        .set(rawMessage)
        .catch(function(e) { console.error('❌ chatMessages write failed:', e.message); });
    }
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
  delete rawUsernames[safeUsername];
  try { const ws = connections[safeUsername]; if (ws) ws.close(); } catch (e) {}
  delete connections[safeUsername];
}
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
    if (c === 4404) {
      console.log('ℹ️ [' + safeUsername + '] User is not live — stopping reconnect');
      delete rawUsernames[safeUsername];
      return;
    }
    if (c === 4400) {
      console.log('❌ [' + safeUsername + '] Invalid TikTok username (uniqueId rejected) — stopping reconnect, this can never succeed by retrying');
      delete rawUsernames[safeUsername];
      return;
    }
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

// ══════════════════════════════════════════════════════════════
// 🔐 AUTH TOKEN ENDPOINT (NEW)
// ══════════════════════════════════════════════════════════════
// Mints a Firebase login token whose identity IS a customer's TikTok
// username — but only after independently re-checking their license
// against Firebase itself (match, not expired, not revoked). This is
// what lets the database rules require auth.uid === $owner, so only
// someone with a genuinely valid, non-revoked license can write to
// that specific board. Uses the same `admin`/`db` already set up
// above — no extra credentials needed.
const AUTH_SECRET = "my_super_secret_key"; // must match main.js / generate.js exactly

app.post('/auth-token', async function(req, res) {
  try {
    const { key, expiry, hwid, tiktok, signature, requestUser } = req.body || {};

    if (!key || !expiry || !hwid || !Array.isArray(tiktok) || !signature || !requestUser) {
      return res.status(400).json({ error: "Missing or malformed license fields" });
    }

    const expectedSig = crypto
      .createHmac('sha256', AUTH_SECRET)
      .update(key + '|' + expiry + '|' + hwid + '|' + JSON.stringify(tiktok))
      .digest('hex');
    if (expectedSig !== signature) {
      return res.status(403).json({ error: "Invalid license signature" });
    }

    if (new Date() > new Date(expiry)) {
      return res.status(403).json({ error: "License expired" });
    }

    const allowed = tiktok.map(function(u) { return safeKey(String(u).toLowerCase()); });
    const reqKey = safeKey(String(requestUser).toLowerCase());
    if (allowed.indexOf(reqKey) === -1) {
      return res.status(403).json({ error: "That TikTok username isn't on this license" });
    }

    const firebaseKey = key.replace(/-/g, "_");
    const licenseSnap = await db.ref('licenses/' + firebaseKey).once('value');
    const revokedSnap = await db.ref('master/revoked/' + firebaseKey).once('value');

    const licenseData = licenseSnap.val();
    if (!licenseData) {
      return res.status(403).json({ error: "License not found" });
    }
    if (revokedSnap.exists()) {
      return res.status(403).json({ error: "License has been revoked" });
    }
    if (licenseData.hwid !== hwid) {
      return res.status(403).json({ error: "HWID mismatch" });
    }
    if (licenseData.expiresAt && Date.now() > licenseData.expiresAt) {
      return res.status(403).json({ error: "License expired" });
    }

    const token = await admin.auth().createCustomToken(reqKey);
    return res.json({ token: token, owner: reqKey });

  } catch (err) {
    console.error("auth-token error:", err.message);
    return res.status(500).json({ error: "Internal error" });
  }
});

app.get('/health',           function(req, res) { res.json({ status: 'ok', connections: Object.keys(connections).length }); });
app.get('/overlay-password', function(req, res) { res.json({ password: 'rckz2026' }); });
process.on('unhandledRejection', function(r) { console.error('⚠️ Unhandled:', r && r.message || r); });
process.on('uncaughtException',  function(e) { console.error('⚠️ Uncaught:',  e && e.message || e); });
const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log('🌐 Server running on port ' + PORT); });
