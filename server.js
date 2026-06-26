const express = require('express');
const { WebcastPushConnection } = require('tiktok-live-connector');
const admin = require("firebase-admin");

const app = express();
app.use(express.json());

// =========================
// 🔥 FIREBASE
// =========================
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
  databaseURL: "https://auction-app-4e98f-default-rtdb.firebaseio.com"
});

const db = admin.database();

// =========================
// 🧠 GLOBAL STATE
// =========================
const connections = {};
const processed = new Set();
const processedChats = new Set();
const lastStreak = {};
const giftBuffer = {};
const vouchCooldown = {};

const FLUSH_DELAY = 250;

// =========================
// 🔧 SAFE KEY
// =========================
function safeKey(str) {
  return str.replace(/[.#$[\]]/g, "_");
}

// =========================
// 🧠 BUFFER SYSTEM
// =========================
function addToBuffer(owner, user, rawUser, amount, photo) {
  const key = `${owner}_${user}`;

  if (!giftBuffer[key]) {
    giftBuffer[key] = {
      name: rawUser,
      score: 0,
      photoUrl: photo || "",
      timeout: null
    };
  }

  giftBuffer[key].score += amount;
  clearTimeout(giftBuffer[key].timeout);

  giftBuffer[key].timeout = setTimeout(async () => {
    const data = giftBuffer[key];
    delete giftBuffer[key];

    try {
      const ref = db.ref(`auctions/${owner}/players/${user}`);
      await ref.transaction(current => {
        if (!current) {
          return { name: data.name, score: data.score, photoUrl: data.photoUrl };
        }
        return { ...current, score: (current.score || 0) + data.score };
      });
      console.log(`✅ [${owner}] ${data.name} +${data.score}`);
    } catch (err) {
      console.error("❌ Firebase error:", err);
    }
  }, FLUSH_DELAY);
}

// =========================
// 🔌 DISCONNECT HELPER
// =========================
function disconnectSafe(safeUsername) {
  try {
    const conn = connections[safeUsername];
    if (conn) {
      conn.disconnect();
    }
  } catch (e) {
    // ignore disconnect errors
  } finally {
    delete connections[safeUsername];
  }
}

// =========================
// 🔌 CONNECT ENDPOINT
// =========================
app.post('/connect', async (req, res) => {
  const rawUsername = req.body.username;
  console.log("📥 /connect hit with:", rawUsername);

  if (!rawUsername) {
    return res.status(400).send("Missing username");
  }

  const safeUsername = safeKey(rawUsername);

  // Clean up any existing connection first
  if (connections[safeUsername]) {
    console.log("♻️ Replacing existing connection:", rawUsername);
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
      sessionId: undefined,
    });
  } catch (err) {
    console.error("❌ Failed to create connection object:", err.message);
    return res.status(500).send("Failed to create connection");
  }

  connections[safeUsername] = connection;

  // ── HANDLE DISCONNECTS ──
  connection.on('disconnected', () => {
    console.log(`⚠️ [${safeUsername}] Disconnected from TikTok`);
    delete connections[safeUsername];
  });

  connection.on('error', (err) => {
    console.error(`❌ [${safeUsername}] Connection error:`, err?.message || err);
  });

  // ── ATTEMPT CONNECT WITH TIMEOUT ──
  let connected = false;
  try {
    await Promise.race([
      connection.connect(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Connection timeout after 12s")), 12000)
      )
    ]);
    connected = true;
    console.log("✅ Connected:", rawUsername);
  } catch (err) {
    console.error("❌ Failed to connect:", err.message);
    disconnectSafe(safeUsername);
    return res.status(500).send("Failed to connect: " + err.message);
  }

  if (!connected) {
    return res.status(500).send("Connection failed");
  }

  // =========================
  // 🎁 GIFT HANDLER
  // =========================
  connection.on('gift', async (data) => {
    try {
      // Guard: data must exist
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
        const giftValues = {
          5655: 5,
          5760: 30,
          7934: 100,
        };

        let baseValue;
        if (Object.prototype.hasOwnProperty.call(giftValues, data.giftId)) {
          baseValue = giftValues[data.giftId];
        } else {
          baseValue = data.diamondCount || 1;
        }
        value = baseValue * repeat;
      }

      // Handle streak gifts
      if (data.giftType === 1) {
        if (!data.repeatEnd) return;
        lastStreak[user] = { time: Date.now(), amount: value };
      } else {
        const last = lastStreak[user];
        if (last && value === 1 && (Date.now() - last.time < 1200)) return;
      }

      addToBuffer(
        safeUsername,
        user,
        rawUser,
        value,
        data.profilePictureUrl || data.user?.profilePictureUrl
      );

    } catch (err) {
      console.error("❌ Gift handler error:", err.message);
    }
  });

  // =========================
  // ⭐ VOUCH SYSTEM
  // =========================
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
      const triggered = words.some(word =>
        typeof word === "string" && message.includes(word.toLowerCase())
      );
      if (!triggered) return;

      // Get current leader
      const playersSnap = await db.ref(`auctions/${safeUsername}/players`).once("value");
      const players = playersSnap.val() || {};

      let top = null;
      Object.values(players).forEach(p => {
        if (!top || p.score > top.score) top = p;
      });

      if (!top) return;
      if (!top.name || !rawUser) return;
      if (top.name.toLowerCase() !== rawUser.toLowerCase()) return;

      // Cooldown
      const key = `${safeUsername}_${user}`;
      if (vouchCooldown[key]) return;
      vouchCooldown[key] = true;
      setTimeout(() => delete vouchCooldown[key], 3000);

      if (auction.vouchedUsers && auction.vouchedUsers[user]) return;

      // Add vouch
      await db.ref(`users/${safeUsername}/vouches`).transaction(v => (v || 0) + 1);
      await db.ref(`auctions/${safeUsername}/vouchedUsers/${user}`).set(true);
      await db.ref(`auctions/${safeUsername}/lastVouch`).set({ user: top.name, time: Date.now() });

      console.log(`💬 WORD VOUCH from ${top.name}`);

    } catch (err) {
      console.error("❌ Chat/vouch error:", err.message);
    }
  });

  res.send("Connected");
});

// =========================
// 🔌 DISCONNECT ENDPOINT
// =========================
app.post('/disconnect', (req, res) => {
  const rawUsername = req.body.username;
  if (!rawUsername) return res.status(400).send("Missing username");
  const safeUsername = safeKey(rawUsername);
  disconnectSafe(safeUsername);
  console.log("⛔ Disconnected:", rawUsername);
  res.send("Disconnected");
});

// =========================
// ❤️ HEALTH CHECK
// =========================
app.get('/health', (req, res) => {
  res.json({ status: "ok", connections: Object.keys(connections).length });
});

app.get('/overlay-password', (req, res) => {
  res.json({ password: "rckz2026" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});
