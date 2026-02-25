const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── Word List ──────────────────────────────────────────────
const WORD_LIST = [
  "Queen", "Sales Tax", "Megillah", "Throne", "Haman", "Desk", "Coffee",
  "Laptop", "Party", "Delaware", "Hamantaschen", "Real Estate", "Pension",
  "King", "10 Sons of Haman", "Calculator", "Shekels", "US Flag",
  "Foreign Income", "Mordechai", "Water Bottle", "Transfer Pricing",
  "Achashverosh", "Mouse", "Deadline", "Israeli Flag", "Mask", "Grogger",
  "Royal Decree", "Bank Account", "Crown", "Florida", "Beit Hamikdash",
  "Costumes", "California", "Tax Refund", "Headset", "Depreciation",
  "Pennsylvania", "New York", "Olim", "Tax Treaty", "Palace", "Gallows",
  "Pencil", "Keyboard", "Horse", "Perfume", "Tzedaka", "Esther", "Wine"
];

// ─── Game State ─────────────────────────────────────────────
const rooms = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function createRoom(hostId, hostName, settings = {}) {
  const code = generateRoomCode();
  const room = {
    code,
    hostId,
    players: new Map(),
    state: 'lobby', // lobby, playing, between_rounds, finished, championship
    currentDrawerIndex: -1,
    currentWord: '',
    roundNumber: 0,
    totalRounds: settings.totalRounds || 10,
    timePerTurn: settings.timePerTurn || 40,
    timer: null,
    timeRemaining: 0,
    usedWords: new Set(),
    drawingData: [],
    correctGuessers: new Set(),
    turnActive: false,
    playerOrder: [],
    isChampionship: settings.isChampionship || false,
    spectators: new Map(),
    hintsRevealed: 0,
    hintInterval: null,
  };
  rooms.set(code, room);
  return room;
}

function getRandomWord(room) {
  const available = WORD_LIST.filter(w => !room.usedWords.has(w));
  if (available.length === 0) {
    room.usedWords.clear();
    return WORD_LIST[Math.floor(Math.random() * WORD_LIST.length)];
  }
  const word = available[Math.floor(Math.random() * available.length)];
  room.usedWords.add(word);
  return word;
}

function getPlayerList(room) {
  const players = [];
  room.players.forEach((p, id) => {
    players.push({ id, name: p.name, score: p.score, isHost: id === room.hostId, isDrawing: room.playerOrder[room.currentDrawerIndex] === id });
  });
  return players.sort((a, b) => b.score - a.score);
}

function getSpectatorList(room) {
  const spectators = [];
  room.spectators.forEach((s, id) => {
    spectators.push({ id, name: s.name });
  });
  return spectators;
}

function generateHint(word, revealCount) {
  const hint = word.split('').map((ch, i) => {
    if (ch === ' ') return '  ';
    if (i < revealCount) return ch;
    return '_';
  });
  return hint.join(' ');
}

function startTurn(room) {
  room.currentDrawerIndex++;

  // Check if we've gone through all players this rotation
  if (room.currentDrawerIndex >= room.playerOrder.length) {
    room.currentDrawerIndex = 0;
  }

  room.roundNumber++;

  if (room.roundNumber > room.totalRounds) {
    endGame(room);
    return;
  }

  const drawerId = room.playerOrder[room.currentDrawerIndex];
  const drawer = room.players.get(drawerId);

  if (!drawer) {
    // Player disconnected, skip
    if (room.roundNumber <= room.totalRounds) {
      startTurn(room);
    }
    return;
  }

  room.currentWord = getRandomWord(room);
  room.drawingData = [];
  room.correctGuessers.clear();
  room.turnActive = true;
  room.timeRemaining = room.timePerTurn;
  room.hintsRevealed = 0;
  room.state = 'playing';

  const hint = generateHint(room.currentWord, 0);

  // Tell everyone a new turn started
  io.to(room.code).emit('turn_start', {
    drawer: { id: drawerId, name: drawer.name },
    hint,
    roundNumber: room.roundNumber,
    totalRounds: room.totalRounds,
    timeRemaining: room.timeRemaining,
    players: getPlayerList(room),
  });

  // Tell the drawer their word
  io.to(drawerId).emit('your_word', { word: room.currentWord });

  // Also emit to spectators
  io.to(room.code + '_spectators').emit('turn_start', {
    drawer: { id: drawerId, name: drawer.name },
    hint,
    roundNumber: room.roundNumber,
    totalRounds: room.totalRounds,
    timeRemaining: room.timeRemaining,
    players: getPlayerList(room),
  });

  // Start countdown timer
  clearInterval(room.timer);
  clearInterval(room.hintInterval);

  room.timer = setInterval(() => {
    room.timeRemaining--;

    io.to(room.code).emit('timer_update', { timeRemaining: room.timeRemaining });
    io.to(room.code + '_spectators').emit('timer_update', { timeRemaining: room.timeRemaining });

    if (room.timeRemaining <= 0) {
      endTurn(room, false);
    }
  }, 1000);

  // Reveal hints progressively
  const wordLen = room.currentWord.replace(/ /g, '').length;
  const hintTimes = [];
  if (wordLen > 3) hintTimes.push(Math.floor(room.timePerTurn * 0.5)); // at 50% time
  if (wordLen > 5) hintTimes.push(Math.floor(room.timePerTurn * 0.25)); // at 25% time

  room.hintInterval = setInterval(() => {
    if (!room.turnActive) return;
    const elapsed = room.timePerTurn - room.timeRemaining;
    const shouldReveal = hintTimes.filter(t => (room.timePerTurn - t) <= elapsed).length;
    if (shouldReveal > room.hintsRevealed) {
      room.hintsRevealed = shouldReveal;
      const hint = generateHint(room.currentWord, room.hintsRevealed);
      // Send hint to guessers only (not drawer)
      room.players.forEach((p, id) => {
        if (id !== drawerId && !room.correctGuessers.has(id)) {
          io.to(id).emit('hint_update', { hint });
        }
      });
      io.to(room.code + '_spectators').emit('hint_update', { hint });
    }
  }, 1000);
}

function endTurn(room, wasGuessed) {
  room.turnActive = false;
  clearInterval(room.timer);
  clearInterval(room.hintInterval);

  io.to(room.code).emit('turn_end', {
    word: room.currentWord,
    wasGuessed,
    players: getPlayerList(room),
    roundNumber: room.roundNumber,
    totalRounds: room.totalRounds,
  });

  io.to(room.code + '_spectators').emit('turn_end', {
    word: room.currentWord,
    wasGuessed,
    players: getPlayerList(room),
    roundNumber: room.roundNumber,
    totalRounds: room.totalRounds,
  });

  // Check if all non-drawer players guessed (everyone got it)
  const drawerId = room.playerOrder[room.currentDrawerIndex];
  const nonDrawerCount = Array.from(room.players.keys()).filter(id => id !== drawerId).length;
  const allGuessed = room.correctGuessers.size >= nonDrawerCount;

  // Wait a few seconds then start next turn
  setTimeout(() => {
    if (room.state !== 'finished' && room.state !== 'lobby') {
      startTurn(room);
    }
  }, allGuessed || !wasGuessed ? 3000 : 5000);
}

function endGame(room) {
  room.state = 'finished';
  clearInterval(room.timer);
  clearInterval(room.hintInterval);

  const players = getPlayerList(room);
  const winner = players.length > 0 ? players[0] : null;

  io.to(room.code).emit('game_over', {
    players,
    winner,
    isChampionship: room.isChampionship,
  });

  io.to(room.code + '_spectators').emit('game_over', {
    players,
    winner,
    isChampionship: room.isChampionship,
  });
}

function handleGuess(room, playerId, guess) {
  if (!room.turnActive) return;
  const drawerId = room.playerOrder[room.currentDrawerIndex];
  if (playerId === drawerId) return; // drawer can't guess
  if (room.correctGuessers.has(playerId)) return; // already guessed correctly

  const player = room.players.get(playerId);
  if (!player) return;

  const normalizedGuess = guess.trim().toLowerCase();
  const normalizedWord = room.currentWord.trim().toLowerCase();

  // Check if guess is correct
  if (normalizedGuess === normalizedWord) {
    room.correctGuessers.add(playerId);

    // Score calculation - based on time remaining
    const timeRatio = room.timeRemaining / room.timePerTurn;
    const guessOrder = room.correctGuessers.size; // 1st, 2nd, 3rd...
    const orderBonus = Math.max(0, 1 - (guessOrder - 1) * 0.15); // diminishing for later guessers
    const guesserPoints = Math.round((200 + 300 * timeRatio) * orderBonus);
    const drawerPoints = Math.round(50 + 100 * timeRatio);

    player.score += guesserPoints;
    const drawer = room.players.get(drawerId);
    if (drawer) drawer.score += drawerPoints;

    io.to(room.code).emit('correct_guess', {
      playerId,
      playerName: player.name,
      points: guesserPoints,
      drawerPoints,
      players: getPlayerList(room),
    });

    io.to(room.code + '_spectators').emit('correct_guess', {
      playerId,
      playerName: player.name,
      points: guesserPoints,
      drawerPoints,
      players: getPlayerList(room),
    });

    // Send the word to the correct guesser
    io.to(playerId).emit('you_guessed_correctly', { word: room.currentWord });

    // Check if all players guessed
    const nonDrawerCount = Array.from(room.players.keys()).filter(id => id !== drawerId).length;
    if (room.correctGuessers.size >= nonDrawerCount) {
      endTurn(room, true);
    }
  } else {
    // Check for close guess (contains the word or is very similar)
    const isClose = (normalizedWord.includes(normalizedGuess) && normalizedGuess.length >= 3) ||
                    (normalizedGuess.includes(normalizedWord));

    // Broadcast the guess to others (but don't reveal if close)
    io.to(room.code).emit('chat_message', {
      playerId,
      playerName: player.name,
      message: guess,
      isClose: isClose && normalizedGuess !== normalizedWord,
    });

    io.to(room.code + '_spectators').emit('chat_message', {
      playerId,
      playerName: player.name,
      message: guess,
      isClose: isClose && normalizedGuess !== normalizedWord,
    });
  }
}

// ─── Socket.IO Events ──────────────────────────────────────
io.on('connection', (socket) => {
  let currentRoom = null;
  let isSpectator = false;

  socket.on('create_room', ({ playerName, totalRounds, timePerTurn, isChampionship }) => {
    const room = createRoom(socket.id, playerName, {
      totalRounds: totalRounds || 10,
      timePerTurn: timePerTurn || 40,
      isChampionship: isChampionship || false,
    });
    room.players.set(socket.id, { name: playerName, score: 0 });
    socket.join(room.code);
    currentRoom = room.code;

    socket.emit('room_created', {
      code: room.code,
      players: getPlayerList(room),
      isChampionship: room.isChampionship,
    });
  });

  socket.on('join_room', ({ roomCode, playerName, asSpectator }) => {
    const code = roomCode.toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      socket.emit('error_message', { message: 'Room not found! Check the code and try again.' });
      return;
    }

    if (asSpectator) {
      room.spectators.set(socket.id, { name: playerName });
      socket.join(code + '_spectators');
      socket.join(code);
      currentRoom = code;
      isSpectator = true;

      socket.emit('joined_as_spectator', {
        code,
        players: getPlayerList(room),
        state: room.state,
        isChampionship: room.isChampionship,
      });

      io.to(code).emit('spectator_joined', {
        name: playerName,
        spectators: getSpectatorList(room),
      });
      return;
    }

    if (room.state !== 'lobby') {
      socket.emit('error_message', { message: 'Game already in progress! You can join as a spectator.' });
      return;
    }

    if (room.players.size >= 10) {
      socket.emit('error_message', { message: 'Room is full! (max 10 players)' });
      return;
    }

    room.players.set(socket.id, { name: playerName, score: 0 });
    socket.join(code);
    currentRoom = code;

    socket.emit('room_joined', {
      code,
      players: getPlayerList(room),
      isChampionship: room.isChampionship,
    });

    io.to(code).emit('player_joined', {
      name: playerName,
      players: getPlayerList(room),
    });
  });

  socket.on('start_game', (settings) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || socket.id !== room.hostId) return;
    if (room.players.size < 2) {
      socket.emit('error_message', { message: 'Need at least 2 players to start!' });
      return;
    }

    // Apply lobby settings (host may have changed them after room creation)
    if (settings) {
      if (settings.totalRounds) room.totalRounds = Math.min(Math.max(parseInt(settings.totalRounds) || 10, 3), 30);
      if (settings.timePerTurn) room.timePerTurn = Math.min(Math.max(parseInt(settings.timePerTurn) || 40, 15), 90);
      if (settings.isChampionship !== undefined) room.isChampionship = !!settings.isChampionship;
    }

    room.state = 'playing';
    room.playerOrder = Array.from(room.players.keys());
    // Shuffle player order
    for (let i = room.playerOrder.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [room.playerOrder[i], room.playerOrder[j]] = [room.playerOrder[j], room.playerOrder[i]];
    }
    room.currentDrawerIndex = -1;
    room.roundNumber = 0;

    io.to(room.code).emit('game_started', {
      players: getPlayerList(room),
      totalRounds: room.totalRounds,
    });

    io.to(room.code + '_spectators').emit('game_started', {
      players: getPlayerList(room),
      totalRounds: room.totalRounds,
    });

    // Brief delay before first turn
    setTimeout(() => startTurn(room), 2000);
  });

  socket.on('draw', (data) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || !room.turnActive) return;
    const drawerId = room.playerOrder[room.currentDrawerIndex];
    if (socket.id !== drawerId) return;

    room.drawingData.push(data);
    socket.to(currentRoom).emit('draw', data);
  });

  socket.on('clear_canvas', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || !room.turnActive) return;
    const drawerId = room.playerOrder[room.currentDrawerIndex];
    if (socket.id !== drawerId) return;

    room.drawingData = [];
    socket.to(currentRoom).emit('clear_canvas');
  });

  socket.on('guess', ({ message }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    handleGuess(room, socket.id, message);
  });

  socket.on('skip_word', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || !room.turnActive) return;
    const drawerId = room.playerOrder[room.currentDrawerIndex];
    if (socket.id !== drawerId) return;

    // Drawer can skip their word (no points)
    endTurn(room, false);
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    if (isSpectator) {
      room.spectators.delete(socket.id);
      io.to(currentRoom).emit('spectator_left', { spectators: getSpectatorList(room) });
      return;
    }

    const player = room.players.get(socket.id);
    if (player) {
      room.players.delete(socket.id);
      room.playerOrder = room.playerOrder.filter(id => id !== socket.id);

      io.to(currentRoom).emit('player_left', {
        name: player.name,
        players: getPlayerList(room),
      });

      // If current drawer left, end turn
      if (room.turnActive && room.playerOrder[room.currentDrawerIndex] === socket.id) {
        endTurn(room, false);
      }

      // If only 1 player left during game, end it
      if (room.state === 'playing' && room.players.size < 2) {
        endGame(room);
      }

      // If room is empty, delete it
      if (room.players.size === 0 && room.spectators.size === 0) {
        clearInterval(room.timer);
        clearInterval(room.hintInterval);
        rooms.delete(currentRoom);
      }

      // If host left, assign new host
      if (socket.id === room.hostId && room.players.size > 0) {
        room.hostId = room.players.keys().next().value;
        io.to(currentRoom).emit('new_host', { hostId: room.hostId, players: getPlayerList(room) });
      }
    }
  });
});

// ─── Start Server ───────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎭 Purim Pictionary server running on port ${PORT}`);
});
