const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const WIN_SCORE = 7;
const rooms = new Map();
const ROUND_SECONDS = 45;

const DEFAULT_BLACK_DECK = [
  { text: 'My toxic trait is _____.', pick: 1 },
  { text: 'Nothing ruins a party faster than _____.', pick: 1 },
  { text: 'At brunch, I accidentally ordered _____.', pick: 1 },
  { text: 'My secret superpower is _____.', pick: 1 },
  { text: 'The real reason the group chat is silent: _____.', pick: 1 },
  { text: 'I knew it was going to be a weird night when _____.', pick: 1 },
  { text: 'Step 1: _____. Step 2: profit.', pick: 1 },
  { text: 'The only thing keeping me going is _____.', pick: 1 },
  { text: 'On my vision board: more money, less stress, and _____.', pick: 1 },
  { text: 'The worst thing to hear on a first date: _____.', pick: 1 }
];

const DEFAULT_WHITE_DECK = [
  'a suspiciously wet sock', 'a dramatic spreadsheet', 'unearned confidence', 'microwaved sushi',
  'a haunted air fryer', 'group project trauma', 'aggressive eye contact', 'a cursed coupon',
  'an emotional support burrito', 'three raccoons in a trench coat', 'a motivational scream',
  'budget champagne', 'a questionable mustache', 'main-character delusion', 'expired glitter',
  'an unsolicited TED Talk', 'cold pizza at 2am', 'vibes and poor decisions', 'an awkward thumbs-up',
  'chaotic neutral energy', 'overpriced coffee', 'instant regret', 'a feral pep talk', 'secondhand embarrassment'
];

function loadDecks() {
  try {
    const blackPath = path.join(__dirname, 'public', 'cards-black.json');
    const whitePath = path.join(__dirname, 'public', 'cards-white.json');
    const black = JSON.parse(fs.readFileSync(blackPath, 'utf8'));
    const white = JSON.parse(fs.readFileSync(whitePath, 'utf8'));

    const validBlack = Array.isArray(black)
      ? black.filter(c => c && typeof c.text === 'string' && Number(c.pick || 1) >= 1).map(c => ({ text: c.text, pick: Number(c.pick || 1) }))
      : [];
    const validWhite = Array.isArray(white)
      ? white.filter(w => typeof w === 'string' && w.trim().length > 0)
      : [];

    return {
      blackDeckBase: validBlack.length ? validBlack : DEFAULT_BLACK_DECK,
      whiteDeckBase: validWhite.length ? validWhite : DEFAULT_WHITE_DECK
    };
  } catch {
    return { blackDeckBase: DEFAULT_BLACK_DECK, whiteDeckBase: DEFAULT_WHITE_DECK };
  }
}

const { blackDeckBase, whiteDeckBase } = loadDecks();

function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function code() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function cleanName(n) {
  return String(n || 'Player').replace(/\s+/g, ' ').trim().slice(0, 24) || 'Player';
}

function uniqueName(room, desired) {
  const base = cleanName(desired);
  if (!room.players.some(p => p.name.toLowerCase() === base.toLowerCase())) return base;
  let i = 2;
  while (room.players.some(p => p.name.toLowerCase() === `${base} ${i}`.toLowerCase())) i++;
  return `${base} ${i}`;
}

function ensureRoom(roomCode) {
  if (rooms.has(roomCode)) return rooms.get(roomCode);
  const room = {
    code: roomCode,
    hostId: null,
    started: false,
    players: [],
    whiteDeck: shuffled(whiteDeckBase),
    blackDeck: shuffled(blackDeckBase),
    discardBlack: [],
    currentBlack: null,
    czarIndex: 0,
    submissions: [],
    round: 0,
    phase: 'lobby',
    phaseEndsAt: null,
    winScore: WIN_SCORE
  };
  rooms.set(roomCode, room);
  return room;
}

function drawWhite(room, count = 1) {
  const out = [];
  for (let i = 0; i < count; i++) {
    if (!room.whiteDeck.length) room.whiteDeck = shuffled(whiteDeckBase);
    out.push(room.whiteDeck.pop());
  }
  return out;
}

function drawBlack(room) {
  if (!room.blackDeck.length) {
    room.blackDeck = shuffled(room.discardBlack.length ? room.discardBlack : blackDeckBase);
    room.discardBlack = [];
  }
  const b = room.blackDeck.pop();
  room.currentBlack = b;
  room.discardBlack.push(b);
}

function publicState(room, viewerId) {
  const czar = room.players[room.czarIndex];
  const waitingOn = room.players
    .filter(p => p.id !== czar?.id && !p.submitted)
    .map(p => ({ id: p.id, name: p.name }));
  return {
    code: room.code,
    started: room.started,
    phase: room.phase,
    round: room.round,
    currentBlack: room.currentBlack,
    winScore: room.winScore || WIN_SCORE,
    czarId: czar?.id || null,
    players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score, handCount: p.hand.length })),
    me: room.players.find(p => p.id === viewerId) || null,
    phaseEndsAt: room.phaseEndsAt,
    waitingOn,
    submissions: room.phase === 'judging'
      ? room.submissions.map(s => ({ id: s.id, cards: s.cards }))
      : []
  };
}

function broadcast(room) {
  room.players.forEach(p => {
    io.to(p.id).emit('state', publicState(room, p.id));
  });
}

function startRound(room) {
  room.round += 1;
  room.phase = 'playing';
  room.phaseEndsAt = Date.now() + ROUND_SECONDS * 1000;
  room.submissions = [];
  drawBlack(room);
  room.players.forEach(p => {
    while (p.hand.length < 10) p.hand.push(...drawWhite(room, 1));
    p.submitted = false;
  });
  broadcast(room);
}

function maybeJudging(room) {
  const czarId = room.players[room.czarIndex]?.id;
  const needed = room.players.filter(p => p.id !== czarId).length;
  if (room.submissions.length >= needed) {
    room.phase = 'judging';
    room.phaseEndsAt = null;
    room.submissions = shuffled(room.submissions);
    broadcast(room);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.phase !== 'playing' || !room.phaseEndsAt) continue;
    if (now < room.phaseEndsAt) continue;

    const czarId = room.players[room.czarIndex]?.id;
    room.players.forEach(p => {
      if (p.id === czarId || p.submitted) return;
      const pick = room.currentBlack?.pick || 1;
      while (p.hand.length < pick) p.hand.push(...drawWhite(room, 1));
      const cards = p.hand.splice(0, pick);
      p.submitted = true;
      room.submissions.push({ id: p.id, cards });
    });

    room.phase = 'judging';
    room.phaseEndsAt = null;
    room.submissions = shuffled(room.submissions);
    io.to(room.code).emit('chat', { name: 'System', text: '⏱️ Time is up. Missing players auto-submitted.' });
    broadcast(room);
  }
}, 1000);

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name }) => {
    let c = code();
    while (rooms.has(c)) c = code();
    const room = ensureRoom(c);
    room.hostId = socket.id;
    room.players.push({ id: socket.id, name: uniqueName(room, name || 'Host'), hand: [], score: 0, submitted: false });
    socket.join(c);
    socket.emit('roomCreated', { code: c });
    broadcast(room);
  });

  socket.on('joinRoom', ({ code: c, name }) => {
    const room = rooms.get((c || '').toUpperCase());
    if (room && room.players.some(p => p.id === socket.id)) {
      socket.emit('roomJoined', { code: room.code });
      return;
    }
    if (!room) return socket.emit('err', 'Room not found.');
    if (room.started) return socket.emit('err', 'Game already started.');
    if (room.players.length >= 10) return socket.emit('err', 'Room full.');
    room.players.push({ id: socket.id, name: uniqueName(room, name || 'Player'), hand: [], score: 0, submitted: false });
    socket.join(room.code);
    socket.emit('roomJoined', { code: room.code });
    broadcast(room);
  });

  socket.on('startGame', ({ code: c, winScore }) => {
    const room = rooms.get((c || '').toUpperCase());
    if (!room || room.hostId !== socket.id) return;
    if (room.players.length < 3) return socket.emit('err', 'Need at least 3 players.');
    room.winScore = [5,7,10].includes(Number(winScore)) ? Number(winScore) : WIN_SCORE;
    room.started = true;
    room.phase = 'playing';
    room.players = shuffled(room.players);
    room.players.forEach(p => { p.hand = drawWhite(room, 10); p.score = 0; p.submitted = false; });
    room.czarIndex = 0;
    room.round = 0;
    startRound(room);
  });

  socket.on('restartGame', ({ code: c, winScore }) => {
    const room = rooms.get((c || '').toUpperCase());
    if (!room || room.hostId !== socket.id) return;
    if (room.players.length < 3) return socket.emit('err', 'Need at least 3 players.');

    room.winScore = [5,7,10].includes(Number(winScore)) ? Number(winScore) : (room.winScore || WIN_SCORE);
    room.started = true;
    room.phase = 'playing';
    room.phaseEndsAt = null;
    room.whiteDeck = shuffled(whiteDeckBase);
    room.blackDeck = shuffled(blackDeckBase);
    room.discardBlack = [];
    room.submissions = [];
    room.players = shuffled(room.players);
    room.players.forEach(p => { p.hand = drawWhite(room, 10); p.score = 0; p.submitted = false; });
    room.czarIndex = 0;
    room.round = 0;
    io.to(room.code).emit('chat', { name: 'System', text: '🔁 New game started.' });
    startRound(room);
  });

  socket.on('submitCards', ({ code: c, cards }) => {
    const room = rooms.get((c || '').toUpperCase());
    if (!room || room.phase !== 'playing') return;
    const player = room.players.find(p => p.id === socket.id);
    const czarId = room.players[room.czarIndex]?.id;
    if (!player || player.id === czarId || player.submitted) return;
    if (!Array.isArray(cards) || cards.length !== (room.currentBlack?.pick || 1)) return;

    for (const card of cards) {
      const i = player.hand.indexOf(card);
      if (i === -1) return;
      player.hand.splice(i, 1);
    }

    player.submitted = true;
    room.submissions.push({ id: socket.id, cards });
    maybeJudging(room);
    broadcast(room);
  });

  socket.on('pickWinner', ({ code: c, winnerId }) => {
    const room = rooms.get((c || '').toUpperCase());
    if (!room || room.phase !== 'judging') return;
    const czar = room.players[room.czarIndex];
    if (!czar || czar.id !== socket.id) return;

    const winner = room.players.find(p => p.id === winnerId);
    if (!winner) return;
    winner.score += 1;

    io.to(room.code).emit('roundResult', { winner: winner.name, cards: room.submissions.find(s => s.id === winnerId)?.cards || [] });

    if (winner.score >= (room.winScore || WIN_SCORE)) {
      room.phase = 'ended';
      io.to(room.code).emit('gameOver', { winner: winner.name });
      broadcast(room);
      return;
    }

    room.phase = 'reveal';
    room.phaseEndsAt = Date.now() + 4000;
    broadcast(room);

    setTimeout(() => {
      const stillRoom = rooms.get(room.code);
      if (!stillRoom || stillRoom.phase !== 'reveal') return;
      stillRoom.czarIndex = (stillRoom.czarIndex + 1) % stillRoom.players.length;
      startRound(stillRoom);
    }, 4000);
  });

  socket.on('chat', ({ code: c, text }) => {
    const room = rooms.get((c || '').toUpperCase());
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    io.to(room.code).emit('chat', { name: player.name, text: (text || '').slice(0, 220) });
  });

  socket.on('disconnect', () => {
    for (const room of rooms.values()) {
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx === -1) continue;
      const wasHost = room.hostId === socket.id;
      room.players.splice(idx, 1);

      if (!room.players.length) {
        rooms.delete(room.code);
        continue;
      }

      if (wasHost) room.hostId = room.players[0].id;
      if (room.czarIndex >= room.players.length) room.czarIndex = 0;

      if (room.phase === 'playing') {
        maybeJudging(room);
      } else {
        broadcast(room);
      }
    }
  });
});

const PORT = process.env.PORT || 3090;
server.listen(PORT, () => console.log(`Chaos Cards running on http://localhost:${PORT}`));