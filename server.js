const express = require('express');
const admin = require("firebase-admin");

const app = express();
app.use(express.json());

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
  databaseURL: "https://auction-app-4e98f-default-rtdb.firebaseio.com"
});

const db = admin.database();

// ── PATCH THE LIBRARY INLINE BEFORE REQUIRING IT ──
// The bug is at index.js:278 — it reads response.status where response is undefined.
// We patch Node's http/https to intercept and fix undefined responses.
const http  = require('http');
const https = require('https');

function safePatch(mod) {
  const _request = mod.request;
  mod.request = function(options, cb) {
    const wrappedCb = cb ? function(res) {
      cb(res || { statusCode: 503, headers: {}, on(e,fn){ if(e==='end')setTimeout(fn,0); return this; }, pipe(){ return this; } });
    } : cb;
    return _request.call(mod, options, wrappedCb);
  };
}
safePatch(http);
safePatch(https);

// Now require the library — it will use our patched http/https
const { WebcastPushConnection } = require('tiktok-live-connector');

const connections    = {};
const processed      = new Set();
const processedChats = new Set();
const lastStreak     = {};
const giftBuffer     = {};
const vouchCooldown  = {};
const FLUSH_DELAY    = 250;

function safeKey(str) {
  return str.replace(/[.#$[\]]/g, "_");
}

function addToBuffer(owner, user, rawUser, amount, photo) {
  const key = `${owner}_${user}`;
  if (!giftBuffer[key]) {
    giftBuffer[key] = { name: rawUser, score: 0, photoUrl: photo || "", timeout: null };
  }
  giftBuffer[key].score += amount;
  clearTimeout(giftBuffer[key].timeout);
  giftBuffer[key].timeout = setTimeout(async () => {
    const data = giftBuffer[key];
    delete giftBuffer[key];
    try {
      await db.ref(`auctions/${owner}/players/${user}`).transaction(current => {
        if (!current) return { name: data.name, score: data.score, photoUrl: data.photoUrl };
        return { ...current, score: (current.score || 0) + data.score };
      });
      console.log(`✅ [${owner}] ${data.name} +${data.score}`);
    } catch (err) {
      console.error("❌ Firebase error:", err.message);
    }
  }, FLUSH_DELAY);
}

function disconnectSafe(safeUsername) {
  try {
    const conn = connections[safeUsername];
    if (conn && typeof conn.disconnect === 'function') conn.disconnect();
  } catch (e) {}
  finally { delete connections[safeUsername]; }
}

app.post('/connect', async (req, res) => {
  const rawUsername = req.body.username;
  console.log("📥 /connect hit with:", rawUsername);
  if (!rawUsername) return res.status(400).send("Missing username");

  const safeUsername = safeKey(rawUsername);
  if (connections[safeUsername]) {
    disconnectSafe(safeUsername);
  }

  console.log("🚀 Connecting:", rawUsername);

  let connection;
  try {
    connection = new WebcastPushConnection(rawUsername, {
      processInitialData: false,
      enableExtendedGiftInfo: true,
      enableWebsocketUpgrade: true,
      requestPollingIntervalMs: 1000,
    });
  } catch (err) {
    console.error("❌ Failed to create connection:", err.message);
    return res.status(500).send("Failed to create connection");
  }

  connections[safeUsername] = connection;

  connection.on('disconnected', () => {
    console.log(`⚠️ [${safeUsername}] Disconnected`);
    delete connections[safeUsername];
  });

  connection.on('error', (err) => {
    console.error(`❌ [${safeUsername}] Error:`, err?.message || JSON.stringify(err));
  });

  try {
    await Promise.race([
      connection.connect(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timeout after 12s")), 12000)
      )
    ]);
  } catch (err) {
    const msg = err?.message || String(err);
    console.error("❌ Failed to connect:", msg);
    disconnectSafe(safeUsername);
    return res.status(503).send("TikTok did not respond — account may be offline or rate-limited. Try again in 30s.");
  }

  console.log("✅ Connected:", rawUsername);

  connection.on('gift', async (data) => {
    try {
      if (!data) return;
      const id = data.msgId || `${data.userId}-${data.giftId}-${Date.now()}`;
      if (processed.has(id)) return;
      processed.add(id);
      setTimeout(() => processed.delete(id), 5000);

      const rawUser = data.uniqueId || "unknown";
      const user = safeKey(rawUser);

      const snap = await db.ref(`auctions/${safeUsername}`).once("value");
      const auction = snap.val();
      if (!auction || !auction.active) return;
      if (auction.snipeEndTime && Date.now() > auction.snipeEndTime) return;

      let value = 0;
      const giftName = (data.giftName || "").toLowerCase();
      const repeat = data.repeatCount || 1;

      if (giftName.includes("rose") || giftName.includes("heart me")) {
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
        data.profilePictureUrl || data.user?.profilePictureUrl);
    } catch (err) {
      console.error("❌ Gift error:", err.message);
    }
  });

  connection.on('chat', async (data) => {
    try {
      if (!data) return;
      const message = (data.comment || "").toLowerCase();
      const id = data.msgId || `${data.userId}-${Date.now()}`;
      if (processedChats.has(id)) return;
      processedChats.add(id);
      setTimeout(() => processedChats.delete(id), 5000);

      const rawUser = data.uniqueId || "";
      const user = safeKey(rawUser);

      const snap = await db.ref(`auctions/${safeUsername}`).once("value");
      const auction = snap.val();
      if (!auction || !auction.active) return;

      const words = auction.vouchWords || [];
      const triggered = words.some(w => typeof w === "string" && message.includes(w.toLowerCase()));
      if (!triggered) return;

      const playersSnap = await db.ref(`auctions/${safeUsername}/players`).once("value");
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
    } catch (err) {
      console.error("❌ Vouch error:", err.message);
    }
  });

  res.send("Connected");
});

app.post('/disconnect', (req, res) => {
  const rawUsername = req.body.username;
  if (!rawUsername) return res.status(400).send("Missing username");
  disconnectSafe(safeKey(rawUsername));
  console.log("⛔ Disconnected:", rawUsername);
  res.send("Disconnected");
});

app.get('/health', (req, res) => {
  res.json({ status: "ok", connections: Object.keys(connections).length });
});

app.get('/overlay-password', (req, res) => {
  res.json({ password: "rckz2026" });
});

process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Unhandled rejection:', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught exception:', err?.message || err);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Server running on port ${PORT}`));
