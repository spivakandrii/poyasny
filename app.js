'use strict';

// =====================================================================
//  Хто я. Окремий id для кожної вкладки, щоб після перезавантаження
//  повернутися в гру тим самим гравцем.
// =====================================================================
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function myId() {
  let id = sessionStorage.getItem('poyasny-id');
  if (!id) {
    id = randomId();
    sessionStorage.setItem('poyasny-id', id);
  }
  return id;
}

const me = { id: myId(), name: '' };
const TEAM_NAMES = ['Сови', 'Лисиці', 'Їжаки', 'Бобри'];
const HELLO_EVERY_MS = 3000;
const HOST_BEAT_MS = 2000;
const OFFLINE_AFTER_MS = 9000;
const HOST_LOST_AFTER_MS = 10000;
const ELECTION_WAIT_MS = 4500;

let room = null;
let isHost = false;
let state = null;
let lastSeq = {};
let liveHostSeenAt = 0;
let localEndsAt = 0;
let deck = [];           // лише в ведучого
let hostEndsAt = 0;      // лише в ведучого
const lastSeen = {};     // лише в ведучого

// =====================================================================
//  Ведучий: тримає стан гри і розсилає його всім
// =====================================================================
function shuffled(list) {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function newGame() {
  return {
    hostId: me.id,
    seq: 0,
    phase: 'lobby',
    settings: { teamCount: 2, seconds: 60, target: 30, penalty: true, decks: Object.keys(DECKS) },
    players: [],
    scores: [],
    rotation: [],
    teamTurn: 0,
    explainerId: null,
    word: null,
    roundWords: [],
    lastWord: null,
    lastTeam: null,
    winner: null
  };
}

function nextWord() {
  if (deck.length === 0) {
    deck = shuffled(state.settings.decks.flatMap(name => DECKS[name].words));
  }
  return deck.pop();
}

function teamSizes() {
  const sizes = Array(state.settings.teamCount).fill(0);
  for (const p of state.players) {
    if (p.team < sizes.length) {
      sizes[p.team]++;
    }
  }
  return sizes;
}

function smallestTeam() {
  const sizes = teamSizes();
  return sizes.indexOf(Math.min(...sizes));
}

function upsertPlayer(id, name) {
  lastSeen[id] = Date.now();
  const player = state.players.find(p => p.id === id);
  if (player) {
    player.name = name;
    player.online = true;
    return;
  }
  state.players.push({ id, name, team: smallestTeam(), online: true });
}

function pickExplainer() {
  const members = state.players.filter(p => p.team === state.teamTurn && p.online);
  if (members.length === 0) {
    state.explainerId = null;
    return;
  }
  state.explainerId = members[state.rotation[state.teamTurn] % members.length].id;
}

function startProblem() {
  const sizes = teamSizes();
  const online = state.players.filter(p => p.online);
  if (online.length !== state.players.length) {
    return 'Дехто з гравців не в мережі.';
  }
  const small = sizes.findIndex(n => n < 2);
  if (small !== -1) {
    return 'У команді «' + TEAM_NAMES[small] + '» має бути щонайменше двоє гравців.';
  }
  if (state.settings.decks.length === 0) {
    return 'Виберіть хоча б один набір слів.';
  }
  return null;
}

function finishRound() {
  const team = state.teamTurn;
  const guessed = state.roundWords.filter(w => w.ok).length;
  const skipped = state.roundWords.length - guessed;
  state.scores[team] += guessed - (state.settings.penalty ? skipped : 0);
  if (state.lastTeam !== null) {
    state.scores[state.lastTeam] += 1;
  }
  state.rotation[team]++;
  state.teamTurn = (team + 1) % state.settings.teamCount;

  if (state.teamTurn === 0) {
    const best = Math.max(...state.scores);
    const leaders = state.scores.filter(s => s === best).length;
    if (best >= state.settings.target && leaders === 1) {
      state.phase = 'over';
      state.winner = state.scores.indexOf(best);
      return;
    }
  }
  state.phase = 'ready';
  pickExplainer();
}

function handleAction(a) {
  if (!state) {
    return;
  }
  const player = state.players.find(p => p.id === a.from);
  if (!player) {
    return;
  }
  const fromHost = a.from === state.hostId;
  const fromExplainer = a.from === state.explainerId;
  const s = state.settings;

  if (a.type === 'team' && state.phase === 'lobby' && Number.isInteger(a.team) && a.team >= 0 && a.team < s.teamCount) {
    player.team = a.team;
  } else if (a.type === 'settings' && fromHost && state.phase === 'lobby') {
    s.teamCount = Math.min(4, Math.max(2, Number(a.settings.teamCount)));
    s.seconds = Number(a.settings.seconds);
    s.target = Number(a.settings.target);
    s.penalty = Boolean(a.settings.penalty);
    s.decks = a.settings.decks.filter(name => DECKS[name]);
    for (const p of state.players) {
      if (p.team >= s.teamCount) {
        p.team = smallestTeam();
      }
    }
  } else if (a.type === 'start' && fromHost && state.phase === 'lobby' && !startProblem()) {
    state.scores = Array(s.teamCount).fill(0);
    state.rotation = Array(s.teamCount).fill(0);
    state.teamTurn = 0;
    state.winner = null;
    deck = [];
    state.phase = 'ready';
    pickExplainer();
  } else if (a.type === 'begin' && fromExplainer && state.phase === 'ready') {
    state.phase = 'play';
    state.roundWords = [];
    state.lastWord = null;
    state.lastTeam = null;
    state.word = nextWord();
    hostEndsAt = Date.now() + s.seconds * 1000;
  } else if ((a.type === 'guess' || a.type === 'skip') && fromExplainer && state.phase === 'play' && state.word) {
    state.roundWords.push({ w: state.word, ok: a.type === 'guess' });
    state.word = nextWord();
  } else if (a.type === 'last' && fromExplainer && state.phase === 'last') {
    state.lastTeam = Number.isInteger(a.team) && a.team >= 0 && a.team < s.teamCount ? a.team : null;
    state.phase = 'review';
  } else if (a.type === 'toggle' && fromExplainer && state.phase === 'review' && state.roundWords[a.index]) {
    state.roundWords[a.index].ok = !state.roundWords[a.index].ok;
  } else if (a.type === 'next' && fromExplainer && state.phase === 'review') {
    finishRound();
  } else if (a.type === 'newgame' && fromHost && state.phase === 'over') {
    state.phase = 'lobby';
  } else {
    return;
  }
  publishState();
}

function hostTick() {
  if (!isHost || !state) {
    return;
  }
  lastSeen[me.id] = Date.now();
  const now = Date.now();
  for (const p of state.players) {
    p.online = now - (lastSeen[p.id] || 0) < OFFLINE_AFTER_MS;
  }
  if (state.phase === 'lobby') {
    state.players = state.players.filter(p => p.online || now - (lastSeen[p.id] || 0) < 3 * OFFLINE_AFTER_MS);
  }
  const explainer = state.players.find(p => p.id === state.explainerId);
  const explainerGone = !explainer || !explainer.online;
  if (state.phase === 'ready' && explainerGone) {
    pickExplainer();
  } else if (state.phase === 'last' && explainerGone) {
    state.lastTeam = null;
    state.phase = 'review';
  } else if (state.phase === 'review' && explainerGone) {
    finishRound();
  }
  publishState();
}

function checkRoundTimer() {
  if (isHost && state && state.phase === 'play' && Date.now() >= hostEndsAt) {
    state.phase = 'last';
    state.lastWord = state.word;
    state.word = null;
    publishState();
  }
}

function publishState() {
  state.seq++;
  const snapshot = Object.assign({}, state, { endsIn: state.phase === 'play' ? hostEndsAt - Date.now() : 0 });
  room.send('state', { state: snapshot }, true);
  localEndsAt = hostEndsAt;
  render();
}

function becomeHost(fromState) {
  isHost = true;
  deck = [];
  if (fromState) {
    state = Object.assign({}, fromState, { hostId: me.id });
    hostEndsAt = Date.now() + (fromState.endsIn || 0);
    for (const p of state.players) {
      lastSeen[p.id] = p.online && p.id !== fromState.hostId ? Date.now() : 0;
    }
  } else {
    state = newGame();
  }
  lastSeq = {};
  upsertPlayer(me.id, me.name);
  publishState();
}

// =====================================================================
//  Повідомлення з кімнати
// =====================================================================
let electionDone = false;

function onNetMessage(channel, message, retained) {
  if (channel === 'state' && message.state) {
    const incoming = message.state;
    if (isHost) {
      // Два ведучих одночасно: лишається той, у кого менший id
      if (incoming.hostId !== me.id && !retained && incoming.hostId < me.id) {
        isHost = false;
      } else {
        return;
      }
    }
    if ((lastSeq[incoming.hostId] || -1) >= incoming.seq) {
      return;
    }
    lastSeq[incoming.hostId] = incoming.seq;
    if (retained) {
      return;
    }
    liveHostSeenAt = Date.now();
    state = incoming;
    localEndsAt = Date.now() + (incoming.endsIn || 0);
    if (electionDone) {
      render();
    }
  } else if (channel === 'hello' && isHost && message.from && message.name) {
    const known = state.players.some(p => p.id === message.from);
    upsertPlayer(message.from, String(message.name).slice(0, 20));
    if (!known) {
      publishState();
    }
  } else if (channel === 'action' && isHost && message.a) {
    handleAction(message.a);
  }
}

function act(type, extra) {
  const a = Object.assign({ type, from: me.id }, extra);
  if (isHost) {
    handleAction(a);
  } else {
    room.send('action', { a });
  }
}

function watchHost() {
  if (isHost || !state || !electionDone) {
    return;
  }
  if (Date.now() - liveHostSeenAt < HOST_LOST_AFTER_MS) {
    return;
  }
  // Ведучий зник: його місце займає гравець з найменшим id
  const candidates = state.players.filter(p => p.online && p.id !== state.hostId).map(p => p.id).sort();
  if (candidates[0] === me.id) {
    becomeHost(state);
  } else {
    $('turnInfo').textContent = 'Звʼязок з ведучим втрачено, чекаємо…';
  }
}

async function joinRoom(name, roomName, password) {
  me.name = name;
  room = new Room(onNetMessage);
  await room.join(roomName, password);
  $('roomBadge').textContent = 'кімната ' + room.code;
  $('roomBadge').hidden = false;

  const hello = () => room.send('hello', { from: me.id, name: me.name });
  hello();
  setInterval(hello, HELLO_EVERY_MS);

  // Чекаємо живого ведучого; нема — стаємо ним самі
  await sleep(ELECTION_WAIT_MS);
  electionDone = true;
  if (!isHost && Date.now() - liveHostSeenAt > ELECTION_WAIT_MS) {
    becomeHost(null);
  }
  render();

  setInterval(hostTick, HOST_BEAT_MS);
  setInterval(watchHost, HOST_BEAT_MS);
  setInterval(tick, 200);
}

// =====================================================================
//  Екран
// =====================================================================
function showScreen(id) {
  for (const s of ['joinScreen', 'lobbyScreen', 'gameScreen']) {
    $(s).hidden = s !== id;
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function playerName(id) {
  const p = state.players.find(x => x.id === id);
  return p ? p.name : '…';
}

function myTeam() {
  const p = state.players.find(x => x.id === me.id);
  return p ? p.team : null;
}

let lastRenderKey = '';
let lastShownWord = null;

function render() {
  if (!state) {
    return;
  }
  const key = JSON.stringify([state.phase, state.explainerId, state.word, state.roundWords, state.lastWord, state.lastTeam,
    state.scores, state.players, state.settings, state.winner, state.teamTurn, isHost]);
  if (key === lastRenderKey) {
    return;
  }
  lastRenderKey = key;

  if (state.phase === 'lobby') {
    showScreen('lobbyScreen');
    renderLobby();
  } else {
    showScreen('gameScreen');
    renderGame();
  }
  updateWakeLock();
}

function renderLobby() {
  const view = $('teamsView');
  view.innerHTML = '';
  for (let t = 0; t < state.settings.teamCount; t++) {
    const box = el('button', 'team' + (myTeam() === t ? ' mine' : ''));
    box.append(el('b', null, TEAM_NAMES[t]));
    for (const p of state.players.filter(x => x.team === t)) {
      const line = (p.id === state.hostId ? '★ ' : '') + p.name + (p.id === me.id ? ' (ви)' : '');
      box.append(el('span', 'player' + (p.online ? '' : ' offline'), line));
    }
    box.addEventListener('click', () => act('team', { team: t }));
    view.append(box);
  }

  $('hostSettings').hidden = !isHost;
  $('lobbyWait').hidden = isHost;
  if (isHost) {
    const s = state.settings;
    $('teamCountInput').value = s.teamCount;
    $('secondsInput').value = s.seconds;
    $('targetInput').value = s.target;
    $('penaltyInput').checked = s.penalty;
    for (const box of document.querySelectorAll('#deckInputs input')) {
      box.checked = s.decks.includes(box.value);
    }
    const problem = startProblem();
    $('startBtn').disabled = Boolean(problem);
    $('startHint').textContent = problem || 'Усе готово!';
  }
}

function renderScores() {
  const list = $('scoreBoard');
  list.innerHTML = '';
  state.scores.forEach((score, t) => {
    const names = state.players.filter(p => p.team === t).map(p => p.name).join(', ');
    const item = el('li', t === state.teamTurn && state.phase !== 'over' ? 'current' : '', TEAM_NAMES[t] + ' — ' + names);
    item.append(el('span', null, String(score)));
    list.append(item);
  });
}

function wordCard(word, small) {
  const card = el('div', 'card');
  const text = el('p', 'word' + (small ? ' small-word' : ''), word);
  if (word !== lastShownWord) {
    text.classList.add('pop');
    lastShownWord = word;
  }
  card.append(text);
  return card;
}

function renderGame() {
  const view = $('roleView');
  view.innerHTML = '';
  const explaining = state.explainerId === me.id;
  const sameTeam = myTeam() === state.teamTurn;
  const explainer = playerName(state.explainerId);
  const team = TEAM_NAMES[state.teamTurn];
  const guessed = state.roundWords.filter(w => w.ok).length;

  $('timer').hidden = state.phase !== 'play';
  $('turnInfo').textContent = state.phase === 'over' ? 'Гру завершено' : 'Хід: ' + team + ' · пояснює ' + explainer;

  if (state.phase === 'ready') {
    const panel = el('div', 'panel center');
    if (explaining) {
      panel.append(el('p', 'big-text', 'Ви пояснюєте!'));
      panel.append(el('p', 'role-note', 'Ваша команда вгадує. Не називайте слово і спільнокореневі.'));
      const go = el('button', 'big', 'Почати раунд');
      go.addEventListener('click', () => act('begin'));
      panel.append(go);
    } else if (sameTeam) {
      panel.append(el('p', 'big-text', 'Готуйтеся вгадувати!'));
      panel.append(el('p', 'role-note', 'Пояснює ' + explainer + '.'));
    } else {
      panel.append(el('p', 'big-text', 'Хід команди «' + team + '»'));
      panel.append(el('p', 'role-note', 'Слухайте пояснення: усі слова покажемо після раунду. Останнє слово можете вгадати й ви!'));
    }
    view.append(panel);
  } else if (state.phase === 'play') {
    if (explaining) {
      view.append(wordCard(state.word));
      const buttons = el('div', 'play-buttons');
      const skip = el('button', 'skip', 'Пропустити');
      const guess = el('button', 'guess', 'Вгадали ✓');
      skip.addEventListener('click', () => act('skip'));
      guess.addEventListener('click', () => act('guess'));
      buttons.append(skip, guess);
      view.append(buttons);
    } else if (sameTeam) {
      const panel = el('div', 'panel center');
      panel.append(el('p', 'big-text', 'Вгадуйте!'));
      panel.append(el('p', 'role-note', 'Пояснює ' + explainer));
      view.append(panel);
    } else {
      const panel = el('div', 'panel center');
      panel.append(el('p', 'big-text', 'Слухайте!'));
      panel.append(el('p', 'role-note', 'Пояснює ' + explainer + ' для команди «' + team + '». Слова покажемо після раунду.'));
      view.append(panel);
    }
    view.append(el('p', 'big-text', 'Вгадано: ' + guessed));
  } else if (state.phase === 'last') {
    const panel = el('div', 'panel center');
    panel.append(el('p', 'eyebrow', 'Час вийшов! Останнє слово'));
    if (explaining) {
      panel.append(el('p', 'word small-word', state.lastWord));
    }
    if (explaining) {
      panel.append(el('p', 'hint', 'Його може вгадати будь-яка команда. Хто встиг?'));
      const stack = el('div', 'stack');
      for (let t = 0; t < state.settings.teamCount; t++) {
        const b = el('button', t === state.teamTurn ? '' : 'secondary', TEAM_NAMES[t]);
        b.addEventListener('click', () => act('last', { team: t }));
        stack.append(b);
      }
      const nobody = el('button', 'link', 'Ніхто не вгадав');
      nobody.addEventListener('click', () => act('last', { team: null }));
      stack.append(nobody);
      panel.append(stack);
    } else {
      panel.append(el('p', 'big-text', 'Вгадують усі!'));
      panel.append(el('p', 'hint', 'Останнє слово може вгадати будь-яка команда. ' + explainer + ' відмітить, хто встиг першим.'));
    }
    view.append(panel);
  } else if (state.phase === 'review') {
    const panel = el('div', 'panel');
    panel.append(el('h2', null, 'Раунд команди «' + team + '»'));
    if (explaining) {
      panel.append(el('p', 'hint', 'Торкніться слова, щоб виправити позначку.'));
    }
    const list = el('ul', 'review');
    state.roundWords.forEach((w, index) => {
      const item = el('li', w.ok ? 'ok' : '');
      item.append(el('span', null, w.w), el('span', 'mark', w.ok ? '✓' : '✕'));
      if (explaining) {
        item.addEventListener('click', () => act('toggle', { index }));
      }
      list.append(item);
    });
    panel.append(list);
    const skipped = state.roundWords.length - guessed;
    const points = guessed - (state.settings.penalty ? skipped : 0);
    panel.append(el('p', 'total', 'Очки за раунд: ' + points));
    if (state.lastWord) {
      const lastResult = state.lastTeam === null ? 'ніхто не вгадав' : '+1 «' + TEAM_NAMES[state.lastTeam] + '»';
      panel.append(el('p', 'role-note', 'Останнє слово «' + state.lastWord + '»: ' + lastResult));
    }
    if (explaining) {
      const next = el('button', 'big', 'Далі');
      next.addEventListener('click', () => act('next'));
      panel.append(next);
    } else {
      panel.append(el('p', 'role-note', 'Чекаємо, поки ' + explainer + ' підтвердить.'));
    }
    view.append(panel);
  } else if (state.phase === 'over') {
    const panel = el('div', 'panel center');
    panel.append(el('p', 'eyebrow', 'Перемогла команда'));
    panel.append(el('p', 'team-name', '🏆 ' + TEAM_NAMES[state.winner]));
    if (isHost) {
      const again = el('button', 'big', 'Нова гра');
      again.addEventListener('click', () => act('newgame'));
      panel.append(again);
    } else {
      panel.append(el('p', 'role-note', 'Нову гру може почати ведучий.'));
    }
    view.append(panel);
  }
  renderScores();
}

// ---------- Таймер, вібрація, звук, екран не гасне ----------
let lastPhase = null;

function beep() {
  try {
    const audio = new AudioContext();
    const osc = audio.createOscillator();
    osc.frequency.value = 660;
    osc.connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.4);
  } catch {
    // звук недоступний — не страшно
  }
}

function tick() {
  checkRoundTimer();
  if (!state) {
    return;
  }
  if (state.phase === 'play') {
    const left = Math.max(0, Math.ceil((localEndsAt - Date.now()) / 1000));
    $('timer').textContent = left;
    $('timer').classList.toggle('hurry', left <= 10);
  }
  if (lastPhase === 'play' && state.phase === 'last') {
    beep();
    if (navigator.vibrate) {
      navigator.vibrate([300, 100, 300]);
    }
  }
  lastPhase = state.phase;
}

let wakeLock = null;

async function updateWakeLock() {
  const want = state && state.phase !== 'lobby' && state.phase !== 'over';
  try {
    if (want && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!want && wakeLock) {
      await wakeLock.release();
    }
  } catch {
    wakeLock = null;
  }
}

// =====================================================================
//  Кнопки
// =====================================================================
for (const [name, deckInfo] of Object.entries(DECKS)) {
  const label = el('label');
  const box = el('input');
  box.type = 'checkbox';
  box.value = name;
  label.append(box, document.createTextNode(' ' + deckInfo.title + ' (' + deckInfo.words.length + ')'));
  $('deckInputs').append(label);
}

function sendSettings() {
  act('settings', {
    settings: {
      teamCount: $('teamCountInput').value,
      seconds: $('secondsInput').value,
      target: $('targetInput').value,
      penalty: $('penaltyInput').checked,
      decks: [...document.querySelectorAll('#deckInputs input:checked')].map(b => b.value)
    }
  });
}

for (const id of ['teamCountInput', 'secondsInput', 'targetInput', 'penaltyInput']) {
  $(id).addEventListener('change', sendSettings);
}
$('deckInputs').addEventListener('change', sendSettings);
$('startBtn').addEventListener('click', () => act('start'));

try {
  $('nameInput').value = localStorage.getItem('poyasny-name') || '';
  $('roomInput').value = localStorage.getItem('poyasny-room') || '';
} catch {
  // сховище недоступне — поля просто порожні
}

$('joinForm').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('nameInput').value.trim();
  const roomName = $('roomInput').value;
  try {
    localStorage.setItem('poyasny-name', name);
    localStorage.setItem('poyasny-room', roomName.trim());
  } catch {
    // не зберегли — не страшно
  }
  $('joinBtn').disabled = true;
  $('joinBtn').textContent = 'Підключення…';
  $('joinError').hidden = true;
  try {
    await joinRoom(name, roomName, $('passwordInput').value);
  } catch (err) {
    $('joinError').textContent = err.message;
    $('joinError').hidden = false;
    $('joinBtn').disabled = false;
    $('joinBtn').textContent = 'Увійти в кімнату';
  }
});

// ---------- PWA ----------
let installPrompt = null;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installPrompt = e;
  $('installBtn').hidden = false;
});

$('installBtn').addEventListener('click', async () => {
  $('installBtn').hidden = true;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js');
}
