const express = require('express');
const { WebcastPushConnection } = require('tiktok-live-connector');
const admin = require("firebase-admin");

const app = express();
app.use(express.json());

// =========================
// 🔥 FIREBASE (FULL FIX)
// =========================
const raw = process.env.FIREBASE_KEY;

if (!raw) {
  throw new Error("FIREBASE_KEY is missing");
}

let serviceAccount;

try {
  serviceAccount = JSON.parse(raw);
} catch (e) {
  console.error("❌ Failed to parse FIREBASE_KEY JSON");
  throw e;
}

// 🔥 FIX PRIVATE KEY FORMATTING (CRITICAL)
if (serviceAccount.private_key) {
  serviceAccount.private_key = serviceAccount.private_key
    .replace(/\\n/g, '\n')
    .replace(/\r/g, '')
    .trim();
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://auction-app-4e98f-default-rtdb.firebaseio.com"
});

const db = admin.database();

// =========================
// 🧠 GLOBAL STATE
// =========================
const connections = {};
const processed = new Set();
const lastStreak = {};
const giftBuffer = {};

const FLUSH_DELAY = 250;

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
      const ref = db.ref(`auction/${owner}/players/${user}`);

      await ref.transaction(current => {
        if (!current) {
          return {
            name: data.name,
            score: data.score,
            photoUrl: data.photoUrl
          };
        }

        return {
          ...current,
          score: (current.score || 0) + data.score
        };
      });

      console.log(`✅ [${owner}] ${data.name} +${data.score}`);

    } catch (err) {
      console.error("❌ Firebase error:", err);
    }

  }, FLUSH_DELAY);
}

// =========================
// 🔌 CONNECT ENDPOINT
// =========================
app.post('/connect', async (req, res) => {
  const username = req.body.username;

  if (!username) {
    return res.status(400).send("Missing username");
  }

  if (connections[username]) {
    return res.send("Already connected");
  }

  console.log("🚀 Connecting:", username);

  const connection = new WebcastPushConnection(username);
  connections[username] = connection;

  try {
    await connection.connect();

    console.log("✅ Connected:", username);

    // 🎁 GIFT HANDLER
    connection.on('gift', async (data) => {

      const id = data.msgId || `${data.userId}-${data.giftId}-${data.timestamp}`;
      if (processed.has(id)) return;

      processed.add(id);
      setTimeout(() => processed.delete(id), 5000);

      const rawUser = data.uniqueId || "unknown";
      const user = rawUser.replace(/[.#$[\]]/g, "_");

      let value = 0;

      // 🧠 STREAK FIX
      if (data.giftType === 1) {
        if (!data.repeatEnd) return;

        value = data.repeatCount || 1;

        lastStreak[user] = {
          time: Date.now(),
          amount: value
        };

      } else {

        value = data.diamondCount || data.repeatCount || 1;

        const last = lastStreak[user];

        if (
          last &&
          value === 1 &&
          (Date.now() - last.time < 1200)
        ) {
          return;
        }
      }

      addToBuffer(
        username,
        user,
        rawUser,
        value,
        data.profilePictureUrl || data.user?.profilePictureUrl
      );
    });

    // 💬 CHAT → BID
    connection.on('chat', async (data) => {

      const msg = data.comment;
      const rawUser = data.uniqueId || "unknown";
      const user = rawUser.replace(/[.#$[\]]/g, "_");

      const num = parseInt(msg);
      if (isNaN(num)) return;

      try {
        await db.ref(`auction/${username}/players/${user}`).update({
          name: rawUser,
          score: num,
          photoUrl:
            data.profilePictureUrl ||
            data.user?.profilePictureUrl ||
            null
        });

        console.log(`💬 [${username}] ${rawUser} bid ${num}`);

      } catch (err) {
        console.error("❌ Chat error:", err);
      }
    });

    res.send("Connected");

  } catch (err) {
    console.error("❌ Failed:", err.message);
    delete connections[username];
    res.status(500).send("Failed to connect");
  }
});

// =========================
// 🚀 START SERVER (RAILWAY SAFE)
// =========================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});
