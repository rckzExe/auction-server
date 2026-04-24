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
const lastStreak = {};
const giftBuffer = {};

const FLUSH_DELAY = 250;

// =========================
// 🔧 SAFE KEY FUNCTION
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

  const rawUsername = req.body.username;

  console.log("📥 /connect hit with:", rawUsername);

  if (!rawUsername) {
    return res.status(400).send("Missing username");
  }

  const safeUsername = safeKey(rawUsername);

  if (connections[safeUsername]) {
    console.log("⚠️ Already connected:", rawUsername);
    return res.send("Already connected");
  }

  console.log("🚀 Connecting:", rawUsername);

  const connection = new WebcastPushConnection(rawUsername);
  connections[safeUsername] = connection;

  try {
    await connection.connect();

    console.log("✅ Connected:", rawUsername);

    // =========================
    // 🎁 GIFT HANDLER
    // =========================
    connection.on('gift', async (data) => {

      const id = data.msgId || `${data.userId}-${data.giftId}-${data.timestamp}`;
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

      // =========================
      // ✅ STRICT FIX (ONLY CHANGE)
      // =========================
      const repeat = data.repeatCount || 1;

      const giftValues = {
        5655: 5,    // finger heart
        5760: 30,   // donut
        7934: 100,  // hand heart
      };

      let baseValue;

      if (Object.prototype.hasOwnProperty.call(giftValues, data.giftId)) {
        baseValue = giftValues[data.giftId];
      } else {
        baseValue = data.diamondCount || 1;
      }

      value = baseValue * repeat;

      // =========================
      // (original anti-spam logic untouched)
      // =========================
      if (data.giftType === 1) {
        if (!data.repeatEnd) return;

        lastStreak[user] = {
          time: Date.now(),
          amount: value
        };
      } else {
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
        safeUsername,
        user,
        rawUser,
        value,
        data.profilePictureUrl || data.user?.profilePictureUrl
      );
    });

    // =========================
    // 💬 CHAT → BID
    // =========================
    connection.on('chat', async (data) => {

      const rawUser = data.uniqueId || "unknown";
      const user = safeKey(rawUser);
      const msg = data.comment;

      const num = parseInt(msg);
      if (isNaN(num)) return;

      const snap = await db.ref(`auctions/${safeUsername}`).once("value");
      const auction = snap.val();

      if (!auction || !auction.active) return;
      if (auction.snipeEndTime && Date.now() > auction.snipeEndTime) return;

      try {
        await db.ref(`auctions/${safeUsername}/players/${user}`).update({
          name: rawUser,
          score: num,
          photoUrl:
            data.profilePictureUrl ||
            data.user?.profilePictureUrl ||
            null
        });

        console.log(`💬 BID: [${rawUsername}] ${rawUser} → ${num}`);

      } catch (err) {
        console.error("❌ Chat error:", err);
      }
    });

    res.send("Connected");

  } catch (err) {
    console.error("❌ Failed:", err.message);
    delete connections[safeUsername];
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
