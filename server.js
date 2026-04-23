const express = require('express');
const { WebcastPushConnection } = require('tiktok-live-connector');
const admin = require("firebase-admin");

const app = express();
app.use(express.json());

// =========================
// 🔥 FIREBASE (FINAL WORKING VERSION)
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

  console.log("📥 /connect hit with:", username); // 🔥 NEW LOG

  if (!username) {
    return res.status(400).send("Missing username");
  }

  if (connections[username]) {
    console.log("⚠️ Already connected:", username); // 🔥 NEW LOG
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

      console.log("🎁 RAW GIFT:", data.uniqueId, data.giftId, data.repeatCount); // 🔥 NEW LOG

      const id = data.msgId || `${data.userId}-${data.giftId}-${data.timestamp}`;
      if (processed.has(id)) return;

      processed.add(id);
      setTimeout(() => processed.delete(id), 5000);

      const rawUser = data.uniqueId || "unknown";
      const user = rawUser.replace(/[.#$[\]]/g, "_");

      let value = 0;

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

      console.log("🎁 PROCESSED:", rawUser, "+", value); // 🔥 NEW LOG

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

      console.log("💬 RAW CHAT:", data.uniqueId, data.comment); // 🔥 NEW LOG

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

        console.log(`💬 BID: [${username}] ${rawUser} → ${num}`); // 🔥 UPDATED LOG

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
// 🚀 START SERVER
// =========================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});
