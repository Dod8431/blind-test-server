const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const fetch = require("node-fetch");


const allowedOrigins = [
  "http://localhost:3000", // pour développement local
  "https://blind-test-client.vercel.app" // ✅ sans slash final
];

const app = express();
app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  }
}));

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"]
  }
});

const rooms = {};

function generateRoomCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let code;
  do {
    code = "";
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  } while (rooms[code]);
  return code;
}

// Endpoint de recherche YouTube
app.get("/search", async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: "q param manquant" });

  try {
    // 1) Récupère la page de résultats
    const response = await fetch(
      `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`
    );
    const html = await response.text();

    // 2) Extrait les premiers 10 videoId via regex
    const ids = Array.from(
      new Set(
        // Cherche toutes les occurrences /watch?v=XXXXXXXXXXX
        [...html.matchAll(/\/watch\?v=([a-zA-Z0-9_-]{11})/g)].map((m) => m[1])
      )
    ).slice(0, 10);

    // Extrait un JSON embedded pour récupérer le titre
const initialDataMatch = html.match(/ytInitialData"\s*:\s*(\{.*?\})\s*;/s);
let titles = [];
if (initialDataMatch) {
  try {
    const initialData = JSON.parse(initialDataMatch[1]);
    // parcours sommaire pour récupérer quelques titres
    const videoItems = initialData.contents.twoColumnSearchResultsRenderer
      .primaryContents.sectionListRenderer.contents[0]
      .itemSectionRenderer.contents;
    titles = videoItems
      .filter((item) => item.videoRenderer)
      .map((v) => v.videoRenderer.title.runs[0].text);
  } catch {}
}
    // 3) Formate la réponse
const results = ids.map((id, i) => ({
  videoId: id,
  title: titles[i] || "Titre non trouvé",
  thumbnail: `https://img.youtube.com/vi/${id}/mqdefault.jpg`
}));

    res.json(results);
  } catch (err) {
    console.error("Erreur search:", err);
    res.status(500).json({ error: "Recherche échouée" });
  }
});


io.on("connection", (socket) => {
  socket.on("createRoom", ({ pseudo }) => {
    const roomCode = generateRoomCode();
    rooms[roomCode] = {
      players: [{ id: socket.id, pseudo, score: 0, admin: true }],
      adminId: socket.id
    };
    socket.join(roomCode);
    socket.emit("roomCreated", { roomCode });
    io.to(roomCode).emit("updatePlayers", rooms[roomCode].players);
  });

  socket.on("joinRoom", ({ pseudo, roomCode }) => {
    const room = rooms[roomCode];
    if (room) {
      room.players.push({ id: socket.id, pseudo, score: 0, admin: false });
      socket.join(roomCode);
      socket.emit("roomJoined", { roomCode });
      io.to(roomCode).emit("updatePlayers", room.players);
    }
  });

  socket.on("startGame", ({ roomCode, scoreLimit }) => {
    const room = rooms[roomCode];
    if (room) {
      room.scoreLimit = scoreLimit || 12; // ⬅️ Défaut à 12 si non précisé
      io.to(roomCode).emit("gameStarted");
    }
  });

  socket.on("restartGame", ({ roomCode }) => {
  const room = rooms[roomCode];
  if (!room) return;

  // Reset scores
  room.players = room.players.map((p) => ({
    ...p,
    score: 0,
  }));

  // Broadcast l’update à tout le monde
  io.to(roomCode).emit("updatePlayers", room.players);

  // Redémarre le jeu
  io.to(roomCode).emit("gameStarted");
});

  socket.on("skipVideo", ({ roomCode }) => {
    io.to(roomCode).emit("videoSkipped");
  });

  socket.on("playVideo", ({ roomCode, videoId }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.currentVideo = videoId;
    room.validatedPoints = 0;
    room.validatedTypes = {};

    io.to(roomCode).emit("playVideo", { videoId });
  });

  socket.on("forceReveal", ({ roomCode }) => {
    io.to(roomCode).emit("revealVideo");
  });

// Le client émet "sendGuess", il faut l'écouter ici
socket.on("sendGuess", ({ roomCode, pseudo, guess }) => {
  const room = rooms[roomCode];
  if (room && room.adminId) {
    // Envoie à l'admin la nouvelle réponse
    io.to(room.adminId).emit("guessReceived", { pseudo, guess });
  } else {
    console.warn(`❌ Guess ignoré : roomCode invalide ou adminId manquant (${roomCode})`);
  }
});



  socket.on("validateGuess", ({ roomCode, pseudo, guess, type }) => {
    const room = rooms[roomCode];
    const player = room.players.find((p) => p.pseudo === pseudo);
    if (!player || !["titre", "artiste"].includes(type)) return;

    room.validatedTypes[pseudo] ||= [];
    if (room.validatedTypes[pseudo].includes(type)) return;

    room.validatedTypes[pseudo].push(type);
    player.score++;
    room.validatedPoints++;

    io.to(roomCode).emit("guessValidated", { pseudo, guess, type });

    if (room.validatedPoints === 2) {
      io.to(roomCode).emit("revealVideo");
    }

    if (room.scoreLimit && player.score >= room.scoreLimit) {
      const winners = [...room.players].sort((a, b) => b.score - a.score);
      io.to(roomCode).emit("endGame", { winners });
    }
  });

  socket.on("rejectGuess", ({ roomCode, pseudo, guess }) => {
    io.to(roomCode).emit("guessRejected", { pseudo, guess });
  });

  socket.on("guessClose", ({ roomCode, pseudo, guess }) => {
  const room = rooms[roomCode];
  if (!room) return;

  io.to(roomCode).emit("guessClose", { pseudo, guess });
});

  socket.on("disconnect", () => {
    for (const code in rooms) {
      const room = rooms[code];
      const idx = room.players.findIndex((p) => p.id === socket.id);
      if (idx !== -1) {
        room.players.splice(idx, 1);
        io.to(code).emit("updatePlayers", room.players);
        if (room.players.length === 0) {
          delete rooms[code];
        }
        break;
      }
    }
  });
});

server.listen(4000, () => console.log("Serveur lancé sur http://localhost:4000"));
