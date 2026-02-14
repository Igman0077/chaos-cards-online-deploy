const socket = io();
const BUILD_ID = '2026-02-13-2115';
let roomCode = null;
let state = null;
let selected = [];
let timerTick = null;

const $ = s => document.querySelector(s);

$('#name').value = localStorage.getItem('chaos_name') || '';
const roomFromUrl = new URLSearchParams(location.search).get('room');
if (roomFromUrl) {
  $('#joinCode').value = roomFromUrl.toUpperCase();
  if (!$('#name').value.trim()) {
    $('#lobbyMsg').textContent = 'Invite detected. Enter your name, then tap Join Room.';
  }
}
let attemptedAutoJoin = false;
setConn('Connecting...');
$('#buildInfo').textContent = `Build: ${BUILD_ID}`;

socket.on('connect', () => {
  setConn('Connected');
  const savedName = ($('#name').value || '').trim();
  if (!attemptedAutoJoin && roomFromUrl && savedName) {
    attemptedAutoJoin = true;
    socket.emit('joinRoom', { code: roomFromUrl.toUpperCase(), name: savedName });
  }
});
socket.on('disconnect', () => setConn('Disconnected'));

$('#createBtn').onclick = () => {
  const name = $('#name').value.trim() || 'Host';
  localStorage.setItem('chaos_name', name);
  socket.emit('createRoom', { name });
};

$('#joinBtn').onclick = () => {
  const name = $('#name').value.trim() || 'Player';
  localStorage.setItem('chaos_name', name);
  const code = $('#joinCode').value.trim().toUpperCase();
  if (!code) {
    $('#lobbyMsg').textContent = 'Enter a room code first.';
    return;
  }
  socket.emit('joinRoom', { code, name });
};

$('#startBtn').onclick = () => socket.emit('startGame', { code: roomCode, winScore: Number($('#winScore').value || 7) });
$('#restartBtn').onclick = () => socket.emit('restartGame', { code: roomCode, winScore: Number($('#winScore').value || 7) });
$('#leaveBtn').onclick = () => location.reload();
$('#copyCodeBtn').onclick = async () => {
  if (!roomCode) return;
  try {
    await navigator.clipboard.writeText(roomCode);
    toast('Room code copied');
  } catch {
    toast(`Code: ${roomCode}`);
  }
};
$('#copyLinkBtn').onclick = async () => {
  if (!roomCode) return;
  const url = `${location.origin}?room=${encodeURIComponent(roomCode)}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Invite link copied');
  } catch {
    toast(url);
  }
};

$('#submitBtn').onclick = () => {
  if (!state || state.phase !== 'playing') return;
  socket.emit('submitCards', { code: roomCode, cards: selected });
};

$('#sendBtn').onclick = sendChat;
$('#chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !state) return;
  const me = state.me;
  const canPlay = state.phase === 'playing' && me && me.id !== state.czarId && !me.submitted;
  const pick = state.currentBlack?.pick || 1;
  if (canPlay && selected.length === pick) {
    socket.emit('submitCards', { code: roomCode, cards: selected });
  }
});

function sendChat() {
  const text = $('#chatInput').value.trim();
  if (!text) return;
  socket.emit('chat', { code: roomCode, text });
  $('#chatInput').value = '';
}

socket.on('roomCreated', ({ code }) => {
  roomCode = code;
  history.replaceState(null, '', `${location.pathname}?room=${encodeURIComponent(code)}`);
  $('#lobbyMsg').textContent = `Room created: ${code}`;
  $('#lobby').classList.add('hidden');
  $('#game').classList.remove('hidden');
});

socket.on('roomJoined', ({ code }) => {
  roomCode = code;
  history.replaceState(null, '', `${location.pathname}?room=${encodeURIComponent(code)}`);
  $('#lobby').classList.add('hidden');
  $('#game').classList.remove('hidden');
});

socket.on('err', (msg) => {
  if (!roomCode) $('#lobbyMsg').textContent = msg;
  else toast(msg);
});

socket.on('state', (s) => {
  state = s;
  selected = [];
  render();
});

socket.on('roundResult', ({ winner, cards }) => {
  addChat(`🏆 ${winner} wins the round with: ${cards.join(' + ')}`);
  const box = $('#roundResult');
  box.classList.remove('hidden');
  box.textContent = `🏆 ${winner} wins this round with: ${cards.join(' + ')}`;
  setTimeout(() => box.classList.add('hidden'), 4200);
});

socket.on('gameOver', ({ winner }) => {
  addChat(`🎉 <span class='win'>${winner} wins the game!</span>`);
});

socket.on('chat', ({ name, text }) => addChat(`<strong>${escapeHtml(name)}:</strong> ${escapeHtml(text)}`));

function render() {
  if (!state) return;
  $('#roomCode').textContent = state.code;
  const phaseLabel = state.phase === 'playing' ? 'PLAYING' : state.phase === 'judging' ? 'JUDGING' : state.phase === 'reveal' ? 'REVEAL' : state.phase.toUpperCase();
  $('#phase').textContent = `Round ${state.round} • ${phaseLabel} • First to ${state.winScore || 7}`;
  const me = state.me;
  const isHost = me && state.hostId === me.id;
  $('#youAreHost').classList.toggle('hidden', !isHost);
  const startBtn = $('#startBtn');
  const restartBtn = $('#restartBtn');
  const submitBtn = $('#submitBtn');

  startBtn.style.display = state.started ? 'none' : (isHost ? 'inline-flex' : 'none');
  $('#winScore').style.display = state.started ? 'none' : (isHost ? 'inline-flex' : 'none');
  restartBtn.classList.toggle('hidden', !(state.phase === 'ended' && isHost));

  startBtn.classList.remove('primary');
  restartBtn.classList.remove('primary');
  submitBtn.classList.remove('primary');
  renderTimer();

  $('#blackCard').textContent = state.currentBlack ? state.currentBlack.text : 'Waiting for host to start…';

  const czarId = state.czarId;
  $('#players').innerHTML = state.players.map(p =>
    `<li>${p.name} ${p.id === czarId ? '👑' : ''} • ${p.score} pts</li>`
  ).join('');

  const canPlay = state.phase === 'playing' && me && me.id !== czarId && !me.submitted;
  const pick = state.currentBlack?.pick || 1;

  $('#handHint').textContent = canPlay
    ? `Pick ${pick} card${pick > 1 ? 's' : ''} • selected ${selected.length}/${pick}`
    : (me && me.id === czarId
      ? 'You are the judge this round.'
      : (me?.submitted ? 'Submitted. Waiting for others...' : 'Waiting...'));

  submitBtn.style.display = canPlay ? 'inline-flex' : 'none';
  submitBtn.disabled = !canPlay || selected.length !== pick;
  if (canPlay) submitBtn.classList.add('primary');
  if (!state.started && isHost) startBtn.classList.add('primary');
  if (state.phase === 'ended' && isHost) restartBtn.classList.add('primary');
  $('#submittedBadge').classList.toggle('hidden', !(me?.submitted && state.phase === 'playing'));

  const turnBadge = $('#turnBadge');
  if (state.phase === 'playing' && me && me.id === czarId) {
    turnBadge.textContent = '👑 You are judging this round';
    turnBadge.classList.remove('hidden');
  } else if (state.phase === 'judging' && me && me.id !== czarId) {
    turnBadge.textContent = '⏳ Waiting for judge decision';
    turnBadge.classList.remove('hidden');
  } else {
    turnBadge.classList.add('hidden');
  }

  const waiting = state.waitingOn || [];
  const meWaiting = waiting.some(w => w.id === me?.id);
  $('#roundStatus').textContent = state.phase === 'playing'
    ? (me && me.id === czarId
      ? `Waiting on ${waiting.length} player(s) to submit.`
      : (meWaiting ? 'Waiting for your submission.' : `Submitted. Waiting on ${waiting.length} other player(s).`))
    : (state.phase === 'judging'
      ? 'Judge is selecting the winner.'
      : (state.phase === 'reveal' ? 'Revealing winner... next round loading.' : ''));

  const myHand = me?.hand || [];
  $('#hand').innerHTML = myHand.map(card =>
    `<button class="white ${selected.includes(card) ? 'sel' : ''}" data-card="${encodeURIComponent(card)}">${escapeHtml(card)}</button>`
  ).join('');

  document.querySelectorAll('[data-card]').forEach(btn => {
    btn.onclick = () => {
      if (!canPlay) return;
      const card = decodeURIComponent(btn.dataset.card);
      if (selected.includes(card)) {
        selected = selected.filter(c => c !== card);
      } else {
        if (selected.length < pick) selected.push(card);
      }
      render();
    };
  });

  const canJudge = state.phase === 'judging' && me && me.id === czarId;
  $('#submissions').innerHTML = (state.submissions || []).map(s => {
    const cards = s.cards.map(c => `<div>${escapeHtml(c)}</div>`).join('');
    return `<div class='entry'>${cards}${canJudge ? `<button class='btn primary' data-win='${s.id}'>Pick Winner</button>` : ''}</div>`;
  }).join('') || '<p class="sub">Waiting for submissions...</p>';

  document.querySelectorAll('[data-win]').forEach(b => {
    b.onclick = () => socket.emit('pickWinner', { code: roomCode, winnerId: b.dataset.win });
  });
}

function addChat(html) {
  const node = document.createElement('div');
  node.innerHTML = html;
  const log = $('#chatLog');
  const nearBottom = (log.scrollHeight - log.scrollTop - log.clientHeight) < 40;
  log.append(node);
  if (nearBottom) log.scrollTop = log.scrollHeight;
}

function setConn(text) {
  const el = $('#conn');
  if (!el) return;
  el.textContent = text;
}

function toast(text) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = text;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 1500);
}

function renderTimer() {
  const el = $('#timer');
  if (!el) return;
  if (timerTick) clearTimeout(timerTick);

  if (state.phase !== 'playing' || !state.phaseEndsAt) {
    el.textContent = '--s';
    return;
  }

  const left = Math.max(0, Math.ceil((state.phaseEndsAt - Date.now()) / 1000));
  el.textContent = `${left}s`;
  timerTick = setTimeout(renderTimer, 250);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}