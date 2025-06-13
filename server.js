const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const allowedOrigins = [
  "http://localhost:3000",                  // pour développement local
  "https://blind-test-client.vercel.app/"             // ← remplace par ton vrai domaine Vercel
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  }
}));
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "http://localhost:3000",
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

  socket.on("startGame", ({ roomCode }) => {
    io.to(roomCode).emit("gameStarted");
  });

  socket.on("skipVideo", ({ roomCode }) => {
    io.to(roomCode).emit("videoSkipped");
  })

socket.on("playVideo", ({ roomCode, videoId }) => {
  const room = rooms[roomCode];
  if (!room) return;

  room.currentVideo = videoId;
  room.validatedPoints = 0; // 👈 compteur de réponses valides
  room.validatedTypes = {}; // ← pseudo => ["titre", "artiste"]

  io.to(roomCode).emit("playVideo", { videoId });
});

  socket.on("forceReveal", ({ roomCode }) => {
    io.to(roomCode).emit("revealVideo");
  });

  socket.on("sendGuess", ({ roomCode, pseudo, guess }) => {
    io.to(rooms[roomCode].adminId).emit("guessReceived", { pseudo, guess });
  });

socket.on("validateGuess", ({ roomCode, pseudo, guess, type }) => {
  const room = rooms[roomCode];
  const player = room.players.find((p) => p.pseudo === pseudo);
  if (!player || !["titre", "artiste"].includes(type)) return;

  // Vérifie si déjà validé
  room.validatedTypes[pseudo] ||= [];
  if (room.validatedTypes[pseudo].includes(type)) return;

  room.validatedTypes[pseudo].push(type);
  player.score++;
  room.validatedPoints++;

  io.to(roomCode).emit("guessValidated", { pseudo, guess, type });

  if (room.validatedPoints === 2) {
    io.to(roomCode).emit("revealVideo");
  }

  if (player.score >= 12) {
    const winners = [...room.players].sort((a, b) => b.score - a.score);
    io.to(roomCode).emit("endGame", { winners });
  }
});


  socket.on("rejectGuess", ({ roomCode, pseudo, guess }) => {
    io.to(roomCode).emit("guessRejected", { pseudo, guess });
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
