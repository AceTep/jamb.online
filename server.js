const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, 'public')));

const ROW_ORDER = ['r1','r2','r3','r4','r5','r6','max','min','dva_para','tris','skala_mala','skala_velika','full','poker','jamb'];
const COLS = ['g','d','sl','naj','kon'];

function getNextRequired(col, scorecard) {
  const sc = scorecard[col];
  if (col === 'g') return ROW_ORDER.find(r => sc[r] === undefined) || null;
  if (col === 'd') return [...ROW_ORDER].reverse().find(r => sc[r] === undefined) || null;
  return null;
}
function canScore(col, rowId, scorecard) {
  if (scorecard[col][rowId] !== undefined) return false;
  const next = getNextRequired(col, scorecard);
  return next === null || next === rowId;
}
function scoreDice(rowId, dice) {
  const c = Array(7).fill(0); dice.forEach(d => c[d]++);
  const s = dice.reduce((a,b) => a+b, 0);
  const nm = {r1:1,r2:2,r3:3,r4:4,r5:5,r6:6};
  if (nm[rowId] !== undefined) return dice.filter(d => d === nm[rowId]).reduce((a,b)=>a+b,0);
  switch(rowId) {
    case 'min': case 'max': return s;
    case 'dva_para': { const pairs = c.slice(1).filter(x=>x>=2).length; return pairs >= 2 ? s+10 : 0; }
    case 'tris': return c.some(x=>x>=3) ? s+10 : 0;
    case 'skala_mala': return [1,2,3,4,5].every(n=>c[n]>0) ? 35 : 0;
    case 'skala_velika': return [2,3,4,5,6].every(n=>c[n]>0) ? 42 : 0;
    case 'full': { const v=c.map((x,i)=>({x,i})).filter(a=>a.x>0&&a.i>0); return v.length===2&&((v[0].x===3&&v[1].x===2)||(v[0].x===2&&v[1].x===3))?s+30:0; }
    case 'poker': return c.some(x=>x>=4) ? s+40 : 0;
    case 'jamb':  return c.some(x=>x>=5) ? s+50 : 0;
    default: return 0;
  }
}
function calcColTotal(colSc) {
  const up = ['r1','r2','r3','r4','r5','r6'].reduce((a,k)=>a+(colSc[k]??0),0);
  const bonus = up >= 60 ? 30 : 0;
  const mx=colSc['max'], mn=colSc['min'], o=colSc['r1'];
  const diff = (mx!==undefined&&mn!==undefined&&o!==undefined) ? (mx-mn)*o : 0;
  const mid = ['dva_para','tris','skala_mala','skala_velika','full','poker','jamb'].reduce((a,k)=>a+(colSc[k]??0),0);
  return up + bonus + diff + mid;
}
function updateTotals(player) {
  COLS.forEach(c => { player.colTotals[c] = calcColTotal(player.scorecard[c]); });
  player.grandTotal = COLS.reduce((a,c) => a + player.colTotals[c], 0);
}
function isColComplete(colSc) { return ROW_ORDER.every(r => colSc[r] !== undefined); }
function isGameOver(scorecard) { return COLS.every(col => isColComplete(scorecard[col])); }
function newScorecard() { const sc={}; COLS.forEach(c=>{sc[c]={};}); return sc; }
function rollN(n) { return Array.from({length:n},()=>Math.floor(Math.random()*6)+1); }
function newTurnState(numDice) {
  const n = numDice||5;
  return { dice:Array(n).fill(1), heldDice:Array(n).fill(false), activeDice:Array(n).fill(true), rollsLeft:3, hasRolled:false, announcement:null };
}
function newPlayer(id, name, token) {
  return { id, name, token: token||null, scorecard:newScorecard(), colTotals:{g:0,d:0,sl:0,naj:0,kon:0}, grandTotal:0 };
}
function createRoom(id, name, hostId, hostName, maxPlayers, numDice) {
  const hostPlayer = Object.values(players).find(p=>p.id===hostId);
  const hostToken = hostPlayer?.token||null;
  const hostProfileToken = hostPlayer?.profileToken||null;
  const nd = (numDice===5||numDice===6) ? numDice : 5;
  return { id, name, host:hostId, hostToken, hostProfileToken, maxPlayers:maxPlayers||4, numDice:nd,
    players:[newPlayer(hostId,hostName,hostToken)], state:'lobby',
    currentPlayerIndex:0, round:1, ...newTurnState(nd),
    activeAnnouncement:null, chat:[] };
}
function advanceTurn(room) {
  room.currentPlayerIndex = (room.currentPlayerIndex+1) % room.players.length;
  if (room.currentPlayerIndex === 0) room.round++;
  const prevAnn = room.activeAnnouncement;
  Object.assign(room, newTurnState(room.numDice));
  room.activeAnnouncement = prevAnn;
}

// ── PERSISTENT PLAYER PROFILES (JSON na disku) ───────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const PROFILES_FILE = path.join(DATA_DIR, 'players.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(PROFILES_FILE)) fs.writeFileSync(PROFILES_FILE, '{}');

let profileDB = {};
try { profileDB = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8')); } catch(e) { profileDB = {}; }

function saveProfiles() {
  try { fs.writeFileSync(PROFILES_FILE, JSON.stringify(profileDB, null, 2)); } catch(e) { console.error('Greška pri snimanju profila:', e); }
}

// Dohvati ili kreiraj profil po imenu (case-insensitive)
function getOrCreateProfile(name) {
  const key = name.toLowerCase();
  if (!profileDB[key]) {
    profileDB[key] = {
      name,                  // originalni casing
      token: genToken(),     // trajni token (ne mijenja se)
      createdAt: Date.now(),
      stats: { wins: 0, losses: 0, gamesPlayed: 0, totalScore: 0, totalJambs: 0, bestScore: 0 }
    };
    saveProfiles();
  }
  return profileDB[key];
}

function updateProfileStats(name, { won, score, jambs }) {
  const key = name.toLowerCase();
  const p = profileDB[key];
  if (!p) return;
  p.stats.gamesPlayed++;
  if (won) p.stats.wins++; else p.stats.losses++;
  p.stats.totalScore += score || 0;
  p.stats.totalJambs += jambs || 0;
  if ((score || 0) > p.stats.bestScore) p.stats.bestScore = score;
  saveProfiles();
}

// ── PERSISTENT ROOMS (JSON na disku) ─────────────────────────────────
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');
if (!fs.existsSync(ROOMS_FILE)) fs.writeFileSync(ROOMS_FILE, '{}');

function saveRooms() {
  try {
    const toSave = {};
    for (const [id, room] of Object.entries(rooms)) {
      if (room.state === 'finished') continue;
      toSave[id] = room;
    }
    fs.writeFileSync(ROOMS_FILE, JSON.stringify(toSave, null, 2));
  } catch(e) { console.error('Greška pri snimanju soba:', e); }
}

// Ucitaj sobe pri startu — igraci ce se reconnectati po imenu
try {
  const saved = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
  for (const [id, room] of Object.entries(saved)) {
    room.players.forEach(p => { p.id = null; }); // socket ID-jevi ne vrijede
    room.host = null;
    rooms[id] = room;
  }
  if (Object.keys(saved).length) console.log('📂 Ucitano', Object.keys(saved).length, 'soba s diska');
} catch(e) {}

// ── SESSION STORE (u memoriji, traje dok server radi) ─────────────────
const SESSION_TTL = 60 * 60 * 1000; // 1h neaktivnosti
const sessions = new Map(); // sessionToken → { name, profileToken, lastSeen, socketId }

function genToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
}
function touchSession(token) {
  const s = sessions.get(token);
  if (s) s.lastSeen = Date.now();
}
function pruneOldSessions() {
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (now - s.lastSeen > SESSION_TTL) {
      if (s.socketId) {
        const sock = io.sockets.sockets.get(s.socketId);
        if (sock) sock.emit('sessionExpired');
      }
      sessions.delete(token);
    }
  }
}
setInterval(pruneOldSessions, 5 * 60 * 1000);

// ── NEAKTIVNOST SOBE (5 min → brisanje) ──────────────────────────
const ROOM_INACTIVITY = 5 * 60 * 1000;
function touchRoom(rid) {
  if (rooms[rid]) rooms[rid].lastActivity = Date.now();
}
function pruneInactiveRooms() {
  const now = Date.now();
  for (const [rid, room] of Object.entries(rooms)) {
    const last = room.lastActivity || now;
    if (now - last > ROOM_INACTIVITY) {
      console.log(`🗑️  Soba ${rid} obrisana zbog neaktivnosti`);
      io.to(rid).emit('roomClosed', { reason: 'Soba zatvorena zbog neaktivnosti (5 min).' });
      io.socketsLeave(rid);
      delete rooms[rid];
    }
  }
  saveRooms();
  io.emit('roomList', getRoomList());
}
setInterval(pruneInactiveRooms, 60 * 1000);

const rooms = {}, players = {};
const roomTimers = new Map();

function getRoomList() {
  return Object.values(rooms).map(r=>({id:r.id,name:r.name,players:r.players.length,maxPlayers:r.maxPlayers,numDice:r.numDice||5,state:r.state,playerNames:r.players.map(p=>p.name)}));
}
function hasRealPlayer(room) {
  return room.players.some(p => !BOT_IDS.has(p.id));
}

function closeRoomBotOnly(rid) {
  const room = rooms[rid];
  if (!room) return;
  console.log(`🗑️  Soba ${rid} zatvorena — nema pravih igrača`);
  io.to(rid).emit('roomClosed', { reason: 'Svi pravi igrači su napustili sobu.' });
  io.socketsLeave(rid);
  delete rooms[rid];
  saveRooms();
  io.emit('roomList', getRoomList());
}

function handleLeave(socket, rid) {
  const room=rooms[rid]; if(!room) return;
  socket.leave(rid);
  room.players=room.players.filter(p=>p.id!==socket.id);
  if(room.players.length===0){delete rooms[rid];}
  else if(!hasRealPlayer(room)){
    // Ostali su samo botovi — zatvori sobu
    closeRoomBotOnly(rid);
    return;
  } else{
    if(room.host===socket.id){
      // Novi host = prvi pravi igrač
      const firstReal = room.players.find(p=>!BOT_IDS.has(p.id));
      room.host = firstReal ? firstReal.id : room.players[0].id;
    }
    if(room.currentPlayerIndex>=room.players.length) room.currentPlayerIndex=0;
    io.to(rid).emit('roomUpdate',room);
  }
  saveRooms();
  io.emit('roomList',getRoomList());
}

// ── BOT LOGIKA ────────────────────────────────────────────────────────
const BOT_NAMES = ['Robko','Jarvis','Skippy','WALL-E','HAL','Data'];
const BOT_IDS = new Set();
let botCounter = 0;

function newBotId() {
  const id = 'bot_' + (++botCounter) + '_' + Math.random().toString(36).slice(2,6);
  BOT_IDS.add(id);
  return id;
}

function isBotTurn(room) {
  const cur = room.players[room.currentPlayerIndex];
  return cur && BOT_IDS.has(cur.id);
}

// Heuristika: biraj najbolji (col, row) za bota
// ── BOT AI — Greedy heuristika ───────────────────────────────────────
//
// botHoldDice: pravila prioriteta za zadržavanje kockica
// botChooseScore: strateški odabir polja i stupca
//
// Prioriteti zadržavanja:
//   jamb (5) > poker (4) > full (3+2) > tris (3) > skala5 > skala4 > par > visoke
//
// Prioriteti stupca:
//   r1-r6: g prvi (bonus), onda sl, onda d
//   kombinacije: d prvi (otvara redosljed odozgo), onda sl
//   max/min: bilo koji slobodni

// ── Analiza kockica ───────────────────────────────────────────────────

function analyseDice(dice) {
  const c = Array(7).fill(0);
  dice.forEach(d => c[d]++);
  const maxCount = Math.max(...c.slice(1));
  const maxVal   = c.indexOf(maxCount, 1);

  // Grupiraj vrijednosti po broju pojavljivanja
  const groups = c.map((cnt, val) => ({ val, cnt })).filter(g => g.val > 0 && g.cnt > 0);
  groups.sort((a, b) => b.cnt - a.cnt || b.val - a.val);

  const hasJamb    = maxCount >= 5;
  const hasPoker   = maxCount >= 4;
  const hasTris    = maxCount >= 3;
  const hasFull    = groups.length >= 2 && groups[0].cnt === 3 && groups[1].cnt === 2;
  const has2para   = groups.length >= 2 && groups[0].cnt >= 2 && groups[1].cnt >= 2;

  // Skala mala [1-5] i velika [2-6] — koliko elemenata niza imamo
  const skalaMalaHave   = [1,2,3,4,5].filter(n => c[n] > 0);
  const skalaVelikaHave = [2,3,4,5,6].filter(n => c[n] > 0);

  return { c, maxCount, maxVal, groups, hasJamb, hasPoker, hasTris, hasFull, has2para, skalaMalaHave, skalaVelikaHave };
}

// ── Koji stupci su slobodni za dani red ───────────────────────────────

function freeColsForRow(row, scorecard) {
  return COLS.filter(col => col !== 'naj' && col !== 'kon' && canScore(col, row, scorecard));
}

function hasAnyFree(row, scorecard) {
  return freeColsForRow(row, scorecard).length > 0;
}

// ── Odabir kockica za zadržati (greedy) ───────────────────────────────

function botHoldDice(room) {
  const dice = room.dice;
  const cur  = room.players[room.currentPlayerIndex];
  const sc   = cur.scorecard;
  const rollsLeft = room.rollsLeft;
  const a    = analyseDice(dice);

  let keepVals = null;
  let reason   = '';

  // ── Kontra obveza: fokusiraj bacanja na taj red ───────────────────
  // Ako je aktivan announcement i bot mora kontirati, drži kockice
  // koje su relevantne za taj red (npr. r1 → drži jedinice)
  const ann = room.activeAnnouncement;
  // Fokusiraj i za vlastitu najavu i za kontra obvezu
  const needFocus = ann && (
    ann.playerId === cur.id ||
    (ann.playerId !== cur.id && sc['kon'][ann.rowId] === undefined)
  );
  if (needFocus) {
    const rowId = ann.rowId;
    const nm = {r1:1,r2:2,r3:3,r4:4,r5:5,r6:6};
    if (nm[rowId] !== undefined) {
      // Gornji red — drži što više kockica te vrijednosti
      const num = nm[rowId];
      keepVals = dice.filter(d => d === num);
      reason = `kontra fokus na ${rowId} (${keepVals.length}x${num})`;
    } else if (rowId === 'tris' || rowId === 'poker' || rowId === 'jamb') {
      // Drži najbrojniju vrijednost
      keepVals = Array(Math.min(a.maxCount, rowId==='tris'?3:rowId==='poker'?4:5)).fill(a.maxVal);
      reason = `kontra fokus na ${rowId} (${a.maxCount}x${a.maxVal})`;
    } else if (rowId === 'full') {
      if (a.hasFull) keepVals = dice.slice();
      else if (a.hasTris) {
        keepVals = Array(3).fill(a.groups[0].val);
        if (a.groups[1]?.cnt >= 2) keepVals.push(a.groups[1].val, a.groups[1].val);
      } else if (a.has2para) {
        keepVals = []; let cnt = 0;
        for (const g of a.groups) { if (g.cnt >= 2 && cnt < 2) { keepVals.push(g.val, g.val); cnt++; } }
      }
      reason = `kontra fokus na full`;
    } else if (rowId === 'skala_mala') {
      const seen = new Set(); keepVals = [];
      for (const d of dice) { if ([1,2,3,4,5].includes(d) && !seen.has(d)) { seen.add(d); keepVals.push(d); } }
      reason = `kontra fokus na skala_mala (${keepVals.length}/5)`;
    } else if (rowId === 'skala_velika') {
      const seen = new Set(); keepVals = [];
      for (const d of dice) { if ([2,3,4,5,6].includes(d) && !seen.has(d)) { seen.add(d); keepVals.push(d); } }
      reason = `kontra fokus na skala_velika (${keepVals.length}/5)`;
    } else if (rowId === 'max') {
      keepVals = dice.filter(d => d >= 4);
      reason = `kontra fokus na max (drzi visoke)`;
    } else if (rowId === 'min') {
      keepVals = dice.filter(d => d <= 2);
      reason = `kontra fokus na min (drzi niske)`;
    }
    if (keepVals !== null) {
      const keptCount = Array(7).fill(0);
      keepVals.forEach(d => keptCount[d]++);
      const held = dice.map(d => { if (keptCount[d] > 0) { keptCount[d]--; return true; } return false; });
      console.log(` [${cur.name}] KONTRA hold: [${dice.filter((_,i)=>held[i]).join(',')}] od [${dice.join(',')}] — ${reason}`);
      return held;
    }
  }

  // 1. Jamb (5 istih) — zadrži sve
  if (a.hasJamb) {
    keepVals = [a.maxVal, a.maxVal, a.maxVal, a.maxVal, a.maxVal];
    reason = `jamb ${a.maxVal}x5`;

  // 2. Poker (4 iste) — zadrži 4
  } else if (a.hasPoker && hasAnyFree('poker', sc)) {
    keepVals = Array(4).fill(a.maxVal);
    reason = `poker ${a.maxVal}x4`;

  // 3. Full house — zadrži sve 5
  } else if (a.hasFull && hasAnyFree('full', sc)) {
    keepVals = dice.slice(); // drži sve
    reason = `full ${a.groups[0].val}x3+${a.groups[1].val}x2`;

  // 4. Tris — ali SAMO ako je vrijedno upisati (provjeri slobodna polja)
  } else if (a.hasTris) {
    const tv = a.groups[0].val; // vrijednost trisa
    const canUseTris    = hasAnyFree('tris', sc);
    const canUsePoker   = hasAnyFree('poker', sc);
    const canUseJamb    = hasAnyFree('jamb', sc);
    const canUseFull    = hasAnyFree('full', sc);
    const canUseUpper   = hasAnyFree(`r${tv}`, sc);
    if (canUseTris || canUsePoker || canUseJamb || canUseFull || canUseUpper) {
      keepVals = Array(3).fill(tv);
      reason = `tris ${tv}x3`;
      // Ako možemo ići na full, zadrži i eventualni par
      if (canUseFull && a.groups.length >= 2 && a.groups[1].cnt >= 2) {
        keepVals = [...keepVals, ...Array(2).fill(a.groups[1].val)];
        reason += ` + par ${a.groups[1].val} (full attempt)`;
      }
    }
  }

  // 5. Skala mala [1-5] — samo ako je dovoljno isplativo
  // Šanse za kompletiranje: 5/5=100%, 4/5 s 2 bac=~30%, 4/5 s 1 bac=~16%, 3/5=prenisko
  if (!keepVals && hasAnyFree('skala_mala', sc)) {
    const have = a.skalaMalaHave;
    if (have.length === 5) {
      keepVals = dice.slice();
      reason = 'skala_mala kompletna';
    } else if (have.length >= 4) {
      // Usporedi EV skale s najboljom alternativom (par u gornjem stupcu)
      const bestPairVal = (() => {
        for (let n = 6; n >= 1; n--) if (a.c[n] >= 2 && hasAnyFree(`r${n}`, sc)) return n * 2;
        return 0;
      })();
      // EV skale male: ~35 * šansa. 4/5 s rollsLeft bacanja
      const skalaEV = rollsLeft >= 2 ? 35 * 0.30 : 35 * 0.16;
      if (skalaEV > bestPairVal || bestPairVal === 0) {
        const seen = new Set(); keepVals = [];
        for (const d of dice) { if ([1,2,3,4,5].includes(d) && !seen.has(d)) { seen.add(d); keepVals.push(d); } }
        reason = `skala_mala ${have.length}/5 (EV=${skalaEV.toFixed(0)} vs par=${bestPairVal})`;
      }
    }
    // 3/5 — preskačemo, preniski EV
  }

  // 6. Skala velika [2-6] — isti princip
  if (!keepVals && hasAnyFree('skala_velika', sc)) {
    const have = a.skalaVelikaHave;
    if (have.length === 5) {
      keepVals = dice.slice();
      reason = 'skala_velika kompletna';
    } else if (have.length >= 4) {
      const bestPairVal = (() => {
        for (let n = 6; n >= 1; n--) if (a.c[n] >= 2 && hasAnyFree(`r${n}`, sc)) return n * 2;
        return 0;
      })();
      const skalaEV = rollsLeft >= 2 ? 42 * 0.30 : 42 * 0.16;
      if (skalaEV > bestPairVal || bestPairVal === 0) {
        const seen = new Set(); keepVals = [];
        for (const d of dice) { if ([2,3,4,5,6].includes(d) && !seen.has(d)) { seen.add(d); keepVals.push(d); } }
        reason = `skala_velika ${have.length}/5 (EV=${skalaEV.toFixed(0)} vs par=${bestPairVal})`;
      }
    }
  }

  // 7. Dva para — zadrži oba (pokušaj full)
  if (!keepVals && a.has2para) {
    keepVals = [];
    let cnt = 0;
    for (const g of a.groups) {
      if (g.cnt >= 2 && cnt < 2) { keepVals.push(g.val, g.val); cnt++; }
    }
    reason = `2 para: ${keepVals.join(',')}`;
  }

  // 8. Par — zadrži par
  if (!keepVals && a.maxCount === 2) {
    keepVals = [a.maxVal, a.maxVal];
    reason = `par ${a.maxVal}x2`;
  }

  // 9. Gornji stupac — ako imamo 2+ iste i g/r{n} slobodan, vrijedi čuvati
  if (!keepVals) {
    // Traži broj koji ima 2+ i g stupac slobodan
    for (let num = 6; num >= 1; num--) {
      if (a.c[num] >= 2 && hasAnyFree(`r${num}`, sc)) {
        keepVals = Array(a.c[num]).fill(num);
        reason = `gornji r${num} ${a.c[num]}x`;
        break;
      }
    }
  }

  // 10. Fallback — zadrži kockice ≥ 4 za max stupac
  if (!keepVals || keepVals.length === 0) {
    keepVals = dice.filter(d => d >= 4);
    reason = `fallback visoke (>=4)`;
  }

  // Mapiraj keepVals natrag na indekse originalnih kockica
  const keptCount = Array(7).fill(0);
  keepVals.forEach(d => keptCount[d]++);
  const held = dice.map(d => {
    if (keptCount[d] > 0) { keptCount[d]--; return true; }
    return false;
  });

  const keptVals = dice.filter((_, i) => held[i]);
  console.log(` [${cur.name}] drzi: [${keptVals.join(',')}] od [${dice.join(',')}] — ${reason}`);
  return held;
}

// ── Odabir stupca (strateški) ─────────────────────────────────────────
//
// r1-r6:        g > sl > d    (g daje bonus za gornji stupac)
// kombinacije:  d > sl        (d ide odozgo, jamb je zadnji → otvara redosljed)
// max/min:      sl > d > g    (nema preference)

function bestColForRow(row, scorecard) {
  const numericRows = new Set(['r1','r2','r3','r4','r5','r6']);
  const free = freeColsForRow(row, scorecard);
  if (free.length === 0) return null;
  if (free.length === 1) return free[0];

  if (numericRows.has(row)) {
    // g > sl > d
    for (const col of ['g', 'sl', 'd']) if (free.includes(col)) return col;
  } else if (row === 'max' || row === 'min') {
    for (const col of ['sl', 'd', 'g']) if (free.includes(col)) return col;
  } else {
    // kombinacije (tris, full, poker, jamb, skale): d > sl > g
    for (const col of ['d', 'sl', 'g']) if (free.includes(col)) return col;
  }
  return free[0];
}

// ── Odabir polja za upis ──────────────────────────────────────────────

function botChooseScore(room) {
  const cur = room.players[room.currentPlayerIndex];
  // Koristi sve kockice — activeDice se ne koristi u greedy pristupu
  const dice = room.dice;
  const sc   = cur.scorecard;
  const ann  = room.activeAnnouncement;
  const a    = analyseDice(dice);

  // Kontra obveza — nema izbora
  if (ann && ann.playerId !== cur.id && sc['kon'][ann.rowId] === undefined) {
    const score = scoreDice(ann.rowId, dice);
    console.log(` [${cur.name}] KONTRA obveza -> kon/${ann.rowId} | [${dice}] -> ${score}`);
    return { col: 'kon', row: ann.rowId };
  }

  // Vlastita najava — upiši u naj stupac za najavljen red
  if (ann && ann.playerId === cur.id && canScore('naj', ann.rowId, sc)) {
    const score = scoreDice(ann.rowId, dice);
    console.log(` [${cur.name}] upisuje NAJAVU naj/${ann.rowId} | [${dice}] -> ${score}`);
    return { col: 'naj', row: ann.rowId };
  }

  // Pomoćna: vrati { col, row, score } ili null
  function tryRow(row) {
    const col = bestColForRow(row, sc);
    if (!col) return null;
    return { col, row, score: scoreDice(row, dice) };
  }

  // ── Kombinacijska polja (samo ako stvarno imamo kombinaciju) ──────────

  // Jamb (5 istih)
  if (a.hasJamb) {
    const r = tryRow('jamb'); if (r) { log(cur, r); return r; }
  }

  // Poker (4 iste)
  if (a.hasPoker) {
    const r = tryRow('poker'); if (r) { log(cur, r); return r; }
  }

  // Full house
  if (a.hasFull) {
    const r = tryRow('full'); if (r) { log(cur, r); return r; }
  }

  // Skala velika [2-6]
  if (a.skalaVelikaHave.length === 5) {
    const r = tryRow('skala_velika'); if (r) { log(cur, r); return r; }
  }

  // Skala mala [1-5]
  if (a.skalaMalaHave.length === 5) {
    const r = tryRow('skala_mala'); if (r) { log(cur, r); return r; }
  }

  // Tris — ali usporedi s gornjim stupcem
  if (a.hasTris) {
    const tv = a.groups[0].val;
    const upperRow = `r${tv}`;
    const upperScore = scoreDice(upperRow, dice); // npr. 3x4 = 12
    const trisScore  = scoreDice('tris', dice);   // 3x4+10 = 22

    const upperOpt = tryRow(upperRow);
    const trisOpt  = tryRow('tris');

    // Odaberi što više vrijedi (uz bonus za gornji jer otvara opcije)
    const upperVal = upperOpt ? upperScore + 5 : -1; // +5 bonus za gornji stupac
    const trisVal  = trisOpt  ? trisScore      : -1;

    if (upperVal >= trisVal && upperOpt) { log(cur, upperOpt); return upperOpt; }
    if (trisOpt) { log(cur, trisOpt); return trisOpt; }
  }

  // ── Gornji stupac r1-r6 — ako imamo bar 2 iste ────────────────────
  for (let num = 6; num >= 1; num--) {
    if (a.c[num] >= 2) {
      const r = tryRow(`r${num}`);
      if (r && r.score > 0) { log(cur, r); return r; }
    }
  }

  // ── Max stupac — ako je suma visoka (>= 20) ───────────────────────
  const sum = dice.reduce((x,y)=>x+y,0);
  if (sum >= 20) {
    const r = tryRow('max'); if (r) { log(cur, r); return r; }
  }

  // ── Min stupac — ako je suma niska (<= 15) ────────────────────────
  if (sum <= 15) {
    const r = tryRow('min'); if (r) { log(cur, r); return r; }
  }

  // ── Fallback: pronađi slobodno polje s najvećim rezultatom ───────
  let best = null, bestScore = -Infinity;
  for (const row of ROW_ORDER) {
    const col = bestColForRow(row, sc);
    if (!col) continue;
    const score = scoreDice(row, dice);
    const numericRows = new Set(['r1','r2','r3','r4','r5','r6']);
    // Penaliziraj upisivanje 0 u kombinacijska polja ako ima slobodnih numeričkih
    const hasFreeNum = ROW_ORDER.filter(r2 => numericRows.has(r2)).some(r2 => freeColsForRow(r2, sc).length > 0);
    const penalty = (!numericRows.has(row) && row !== 'max' && row !== 'min' && score === 0 && hasFreeNum) ? 100 : 0;
    const val = score - penalty;
    if (val > bestScore) { bestScore = val; best = { col, row, score }; }
  }

  if (best) { log(cur, best); return best; }
  console.log(` [${cur.name}] nema slobodnog polja!`);
  return null;
}

function log(cur, r) {
  console.log(` [${cur.name}] upisuje ${r.col}/${r.row} -> ${r.score}`);
}

// ── Bot najava (prije prvog bacanja) ─────────────────────────────────
//
// Bot odlučuje hoće li najaviti i što, na temelju:
//   - slobodnih naj polja
//   - EV (vrijednost × šansa uspjeha)
//   - random faktora da ne bude 100% predvidiv

function botDecideAnnounce(room) {
  const cur = room.players[room.currentPlayerIndex];
  const sc  = cur.scorecard;

  // Ako naj stupac nije slobodan ni za jedno polje — skip
  // Ako je kontra aktivna — bot ne najavljuje (mora kontirati)
  if (room.activeAnnouncement) return null;

  // Šanse uspjeha za svako polje (empirijske vjerojatnosti bez ikakve informacije)
  // i bazna vrijednost polja
  const candidates = [
    { row: 'max',          ev: 21,  successRate: 1.00, baseChance: 0.12 },
    { row: 'min',          ev: 14,  successRate: 1.00, baseChance: 0.10 },
    { row: 'tris',         ev: 24,  successRate: 0.28, baseChance: 0.15 },
    { row: 'full',         ev: 28,  successRate: 0.06, baseChance: 0.08 },
    { row: 'poker',        ev: 50,  successRate: 0.12, baseChance: 0.10 },
    { row: 'jamb',         ev: 65,  successRate: 0.03, baseChance: 0.05 },
    { row: 'skala_mala',   ev: 35,  successRate: 0.03, baseChance: 0.06 },
    { row: 'skala_velika', ev: 42,  successRate: 0.03, baseChance: 0.07 },
    { row: 'r1',           ev:  3,  successRate: 1.00, baseChance: 0.08 },
    { row: 'r2',           ev:  6,  successRate: 1.00, baseChance: 0.08 },
    { row: 'r3',           ev:  9,  successRate: 1.00, baseChance: 0.09 },
    { row: 'r4',           ev: 12,  successRate: 1.00, baseChance: 0.10 },
    { row: 'r5',           ev: 15,  successRate: 1.00, baseChance: 0.11 },
    { row: 'r6',           ev: 18,  successRate: 1.00, baseChance: 0.12 },
  ];

  // Filtriraj samo slobodna naj polja
  const free = candidates.filter(c => canScore('naj', c.row, sc));
  if (free.length === 0) return null;

  // Za svako slobodno polje izračunaj "privlačnost" = EV × successRate × random
  // Dodaj random šum da bot ne najavuje uvijek isto
  const scored = free.map(c => ({
    ...c,
    score: c.ev * c.successRate * c.baseChance * (0.5 + Math.random())
  }));

  // Sortiraj i uzmi najboljeg kandidata
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];

  // Odluči hoće li uopće najaviti — kumulativna šansa
  // Što je viši score, to je veća šansa da se odluči za najavu
  const announceThreshold = 0.18; // ~18% poteza završi najavom
  if (Math.random() > announceThreshold) return null;

  console.log(` [${cur.name}] NAJAVA: naj/${best.row} (score=${best.score.toFixed(2)})`);
  return best.row;
}

function scheduleBotTurn(rid) {
  const room = rooms[rid];
  if (!room || room.state !== 'playing') return;
  if (!isBotTurn(room)) return;

  // Botov potez — s malim kašnjenjem da izgleda prirodnije
  setTimeout(() => {
    const room = rooms[rid];
    if (!room || room.state !== 'playing' || !isBotTurn(room)) return;

    // Razmisli o najavi prije prvog bacanja
    const announceRow = botDecideAnnounce(room);
    if (announceRow) {
      const cur = room.players[room.currentPlayerIndex];
      room.activeAnnouncement = { playerId: cur.id, rowId: announceRow };
      io.to(rid).emit('roomUpdate', room);
    }

    // Baci kockice (do 3 puta)
    const doRoll = (rollsLeft) => {
      if (rollsLeft <= 0) {
        // Odaberi polje
        const choice = botChooseScore(room);
        if (choice) {
          // Simuliraj scoreCategory
          const cur = room.players[room.currentPlayerIndex];
          if (!room.activeDice) room.activeDice = Array(room.numDice||5).fill(true);
          const activeDice = room.dice.filter((_,i) => room.activeDice[i]);
          cur.scorecard[choice.col][choice.row] = scoreDice(choice.row, activeDice);
          updateTotals(cur);

          // Najava handling — ako bot upisuje u naj stupac, aktiviraj announcement za ostale
          if (choice.col === 'naj') {
            const cur2 = room.players[room.currentPlayerIndex];
            room.activeAnnouncement = { playerId: cur2.id, rowId: choice.row };
          }

          // Kontra handling — provjeri je li svi kontirali pa ugasi activeAnnouncement
          if (choice.col === 'kon' && room.activeAnnouncement) {
            const aid = room.activeAnnouncement.playerId;
            const rid2 = room.activeAnnouncement.rowId;
            const allDone = room.players.filter(p => p.id !== aid).every(p => p.scorecard['kon'][rid2] !== undefined);
            if (allDone) room.activeAnnouncement = null;
          }

          if (room.players.every(p => isGameOver(p.scorecard))) {
            room.state = 'finished';
            const maxScore = Math.max(...room.players.map(p => p.grandTotal));
            room.players.forEach(rp => {
              if (!BOT_IDS.has(rp.id)) {
                const jambs = Object.values(rp.scorecard).reduce((sum, col) => sum + (col['jamb'] > 0 ? 1 : 0), 0);
                updateProfileStats(rp.name, { won: rp.grandTotal === maxScore, score: rp.grandTotal, jambs });
              }
            });
            saveRooms();
            io.to(rid).emit('gameOver', room);
            io.emit('roomList', getRoomList());
            return;
          }
          advanceTurn(room);
          saveRooms();
          io.to(rid).emit('roomUpdate', room);
          // Ako je opet bot na redu
          scheduleBotTurn(rid);
        }
        return;
      }

      // Baci kockice
      room.dice = room.dice.map((d,i) => room.heldDice[i] ? d : rollN(1)[0]);
      room.rollsLeft--;
      room.hasRolled = true;
      io.to(rid).emit('roomUpdate', room);

      // Ako još ima bacanja, odluči što zadržati
      if (room.rollsLeft > 0) {
        const held = botHoldDice(room);
        room.heldDice = held;
        // Ako su sve kockice zadržane — nema smisla nastaviti
        if (held.every(Boolean)) {
          room.rollsLeft = 0;
          io.to(rid).emit('roomUpdate', room);
          setTimeout(() => doRoll(0), 500);
          return;
        }
        const nextDelay = 700 + Math.random() * 500;
        setTimeout(() => doRoll(rollsLeft - 1), nextDelay);
      } else {
        // Zadnje bacanje — idi na upis
        setTimeout(() => doRoll(0), 500);
      }
    };

    doRoll(room.rollsLeft);
  }, 1200 + Math.random() * 800);
}

io.on('connection',(socket)=>{

  // ── LOGIN: dohvati ili kreiraj profil po imenu ─────────────────────
  socket.on('setName',(name)=>{
    const trimmed = name.trim().slice(0,20);
    if (!trimmed) return;

    const key = trimmed.toLowerCase();
    const existing = profileDB[key];

    // Ako profil postoji, provjeri je li netko trenutno online s tim imenom
    if (existing) {
      const takenOnline = Object.values(players).find(p => p.name.toLowerCase() === key && p.id !== socket.id);
      if (takenOnline) {
        // Provjeri je li taj socket još stvarno povezan
        const takenSocket = io.sockets.sockets.get(takenOnline.id);
        if (takenSocket && takenSocket.connected) {
          return socket.emit('error', `Ime "${trimmed}" je trenutno zauzeto — netko je već prijavljen s tim imenom!`);
        }
        // Stari socket više nije connected — očisti ga
        delete players[takenOnline.id];
      }
    }

    const profile = getOrCreateProfile(trimmed);
    const sessionToken = genToken();
    sessions.set(sessionToken, { name: profile.name, profileToken: profile.token, lastSeen: Date.now(), socketId: socket.id });
    players[socket.id] = { id: socket.id, name: profile.name, token: sessionToken, profileToken: profile.token };

    socket.emit('nameSet', { name: profile.name, token: sessionToken, profileToken: profile.token });
    socket.emit('roomList', getRoomList());
  });

  // ── OBNOVA SESIJE s tokenom iz localStorage ────────────────────────
  socket.on('resumeSession',(sessionToken)=>{
    const s = sessions.get(sessionToken);
    if (!s || Date.now() - s.lastSeen > SESSION_TTL) {
      sessions.delete(sessionToken);
      // Pokušaj s profileToken iz localStorage (trajno pamćenje)
      return socket.emit('sessionExpired');
    }
    s.socketId = socket.id;
    s.lastSeen = Date.now();
    players[socket.id] = { id: socket.id, name: s.name, token: sessionToken, profileToken: s.profileToken };

    let rejoinedRoom = null;
    for (const room of Object.values(rooms)) {
      const p = room.players.find(p => p.token === sessionToken);
      if (p) {
        p.id = socket.id;
        socket.join(room.id);
        rejoinedRoom = room;
        if (room.hostToken === sessionToken) room.host = socket.id;
        break;
      }
    }

    socket.emit('sessionResumed', { name: s.name, token: sessionToken, profileToken: s.profileToken, room: rejoinedRoom });
    if (rejoinedRoom) {
      // Cancela timer za gašenje sobe ako se owner vratio
      if (roomTimers.has(rejoinedRoom.id)) {
        clearTimeout(roomTimers.get(rejoinedRoom.id));
        roomTimers.delete(rejoinedRoom.id);
      }
      io.to(rejoinedRoom.id).emit('roomUpdate', rejoinedRoom);
    }
    socket.emit('roomList', getRoomList());
  });

  // ── OBNOVA S PROFILE TOKEN (trajni — preživljava restart servera) ──
  socket.on('resumeWithProfileToken',(profileToken)=>{
    const profile = Object.values(profileDB).find(p => p.token === profileToken);
    if (!profile) return socket.emit('sessionExpired');

    const sessionToken = genToken();
    sessions.set(sessionToken, { name: profile.name, profileToken, lastSeen: Date.now(), socketId: socket.id });
    players[socket.id] = { id: socket.id, name: profile.name, token: sessionToken, profileToken };

    // Pronadi sobu u kojoj je igrac bio (po imenu)
    let rejoinedRoom = null;
    for (const room of Object.values(rooms)) {
      const rp = room.players.find(p => p.name === profile.name);
      if (rp) {
        rp.id = socket.id;
        rp.token = sessionToken;
        socket.join(room.id);
        rejoinedRoom = room;
        if (room.hostProfileToken === profileToken) room.host = socket.id;
        break;
      }
    }

    socket.emit('sessionResumed', { name: profile.name, token: sessionToken, profileToken, room: rejoinedRoom });
    if (rejoinedRoom) {
      if (roomTimers.has(rejoinedRoom.id)) {
        clearTimeout(roomTimers.get(rejoinedRoom.id));
        roomTimers.delete(rejoinedRoom.id);
      }
      io.to(rejoinedRoom.id).emit('roomUpdate', rejoinedRoom);
    }
    socket.emit('roomList', getRoomList());
  });

  // ── DOHVAT STATISTIKE ─────────────────────────────────────────────
  socket.on('getProfile', () => {
    const p = players[socket.id];
    if (!p) return;
    const profile = profileDB[p.name.toLowerCase()];
    if (!profile) return;
    socket.emit('profileData', { name: profile.name, stats: profile.stats, createdAt: profile.createdAt });
  });

  socket.on('ping', (token) => { if(token) touchSession(token); });
  socket.on('getRooms',()=>socket.emit('roomList',getRoomList()));

  socket.on('createRoom',({roomName,maxPlayers,numDice})=>{
    const p=players[socket.id]; if(!p) return;
    const rid=Math.random().toString(36).slice(2,8).toUpperCase();
    const nd=numDice||5, max=maxPlayers||4;
    rooms[rid]=createRoom(rid,roomName||`${p.name}'s soba`,socket.id,p.name,max,nd);
    rooms[rid].lastActivity=Date.now();
    socket.join(rid);
    // Solo soba — odmah startaj igru bez čekaonice
    if(max===1){
      rooms[rid].state='playing';
      socket.emit('gameStarted',rooms[rid]);
    } else {
      socket.emit('roomJoined',rooms[rid]);
    }
    io.emit('roomList',getRoomList()); saveRooms();
  });

  socket.on('joinRoom',(rid)=>{
    const p=players[socket.id],room=rooms[rid];
    if(!p||!room) return socket.emit('error','Soba nije pronađena!');
    if(room.state!=='lobby') return socket.emit('error','Igra je već u tijeku!');
    if(room.players.length>=room.maxPlayers) return socket.emit('error','Soba je puna!');
    if(room.players.find(x=>x.id===socket.id)){socket.join(rid);return socket.emit('roomJoined',room);}
    room.players.push(newPlayer(socket.id,p.name,p.token));
    socket.join(rid); socket.emit('roomJoined',room);
    touchRoom(rid);
    io.to(rid).emit('roomUpdate',room); io.emit('roomList',getRoomList());
  });

  socket.on('startGame',(rid)=>{
    const room=rooms[rid]; if(!room||room.host!==socket.id) return;
    room.state='playing'; room.currentPlayerIndex=0; room.round=1;
    room.activeAnnouncement=null; Object.assign(room,newTurnState(room.numDice));
    io.to(rid).emit('gameStarted',room); io.emit('roomList',getRoomList()); saveRooms();
    // Ako je prvi na redu bot, pokreni bot potez
    scheduleBotTurn(rid);
  });

  socket.on('addBot',(rid)=>{
    const room=rooms[rid];
    if(!room||room.host!==socket.id) return;
    if(room.state!=='lobby') return socket.emit('error','Botovi se mogu dodati samo u čekaonici!');
    if(room.players.length>=room.maxPlayers) return socket.emit('error','Soba je puna!');
    // Odaberi ime bota koje nije već u sobi
    const usedNames = room.players.map(p=>p.name);
    const availName = BOT_NAMES.find(n=>!usedNames.includes(n)) || ` Bot${room.players.length+1}`;
    const botId = newBotId();
    const bot = newPlayer(botId, availName, null);
    bot.isBot = true;
    room.players.push(bot);
    touchRoom(rid);
    io.to(rid).emit('roomUpdate',room);
    io.emit('roomList',getRoomList());
    saveRooms();
  });

  socket.on('removeBot',({rid, botId})=>{
    const room=rooms[rid];
    if(!room||room.host!==socket.id) return;
    if(room.state!=='lobby') return socket.emit('error','Ne možeš ukloniti bota za vrijeme igre!');
    const botIdx = room.players.findIndex(p => p.id === botId && BOT_IDS.has(p.id));
    if(botIdx === -1) return;
    room.players.splice(botIdx, 1);
    if(room.currentPlayerIndex>=room.players.length) room.currentPlayerIndex=0;
    touchRoom(rid);
    io.to(rid).emit('roomUpdate',room);
    io.emit('roomList',getRoomList());
    saveRooms();
  });

  socket.on('announce',({roomId,rowId})=>{
    const room=rooms[roomId]; if(!room||room.state!=='playing') return;
    const cur=room.players[room.currentPlayerIndex];
    if(cur.id!==socket.id) return socket.emit('error','Nije tvoj red!');
    if(room.hasRolled) return socket.emit('error','Najava mora biti PRIJE bacanja!');
    if(cur.scorecard['naj'][rowId]!==undefined) return socket.emit('error','To polje je već popunjeno!');
    room.announcement={playerId:socket.id,playerName:cur.name,rowId};
    io.to(roomId).emit('roomUpdate',room);
  });

  socket.on('rollDice',(rid)=>{
    if(players[socket.id]?.token) touchSession(players[socket.id].token);
    const room=rooms[rid]; if(!room||room.state!=='playing') return;
    touchRoom(rid);
    const cur=room.players[room.currentPlayerIndex];
    if(cur.id!==socket.id||room.rollsLeft<=0) return;
    room.dice=room.dice.map((d,i)=>room.heldDice[i]?d:rollN(1)[0]);
    room.rollsLeft--;
    room.hasRolled=true;
    if(room.rollsLeft===0){
      const anyHeld=room.heldDice.some(Boolean);
      room.activeDice=room.heldDice.map(h=>anyHeld?h:true);
      room.heldDice=Array(room.numDice||5).fill(false);
    }
    io.to(rid).emit('roomUpdate',room);
  });

  socket.on('toggleHold',({roomId,index})=>{
    const room=rooms[roomId]; if(!room||room.state!=='playing') return;
    if(room.players[room.currentPlayerIndex].id!==socket.id) return;
    if(!room.hasRolled||room.rollsLeft<=0) return;
    room.heldDice[index]=!room.heldDice[index];
    io.to(roomId).emit('roomUpdate',room);
  });

  socket.on('toggleActiveDie',({roomId,index})=>{
    const room=rooms[roomId]; if(!room||room.state!=='playing') return;
    if(room.players[room.currentPlayerIndex].id!==socket.id) return;
    if(!room.hasRolled) return;
    if(!room.activeDice) room.activeDice=Array(room.numDice||5).fill(true);
    const currentlyActive=room.activeDice[index];
    // Ako pokušava aktivirati — provjeri da nema već 5 aktivnih
    if(!currentlyActive){
      const activeCount=room.activeDice.filter(Boolean).length;
      if(activeCount>=5) return; // max 5
    }
    room.activeDice[index] = !currentlyActive;
    io.to(roomId).emit('roomUpdate',room);
  });

  socket.on('scoreCategory',({roomId,col,row})=>{
    const room=rooms[roomId]; if(!room||room.state!=='playing') return;
    touchRoom(roomId);
    const cur=room.players[room.currentPlayerIndex];
    if(cur.id!==socket.id) return socket.emit('error','Nije tvoj red!');
    if(!room.hasRolled) return socket.emit('error','Prvo baci kockice!');

    const isSoloGame = room.players.length === 1;
    const mustKontra = room.activeAnnouncement
                       && (isSoloGame || room.activeAnnouncement.playerId !== socket.id)
                       && cur.scorecard['kon'][room.activeAnnouncement.rowId] === undefined;
    const mustNajava = !!room.announcement;

    if(mustKontra){
      if(col !== 'kon') return socket.emit('error','Kontra je aktivna — moraš upisati u ⚡ Kontra stupac!');
      if(row !== room.activeAnnouncement.rowId) return socket.emit('error',`Moraš upisati kontra za: ${room.activeAnnouncement.rowId}!`);
    }
    if(mustNajava){
      if(col !== 'naj') return socket.emit('error','Najavil/a si polje — moraš upisati u 📢 Najava stupac!');
      if(row !== room.announcement.rowId) return socket.emit('error','Možeš upisati samo najavljeno polje!');
    }
    if(col==='naj' && !room.announcement) return socket.emit('error','Nisi najavil/a polje!');
    if(col==='naj' && row !== room.announcement.rowId) return socket.emit('error','Možeš upisati samo najavljeno polje!');
    if(col==='kon'){
      if(!room.activeAnnouncement) return socket.emit('error','Nema aktivne najave za kontru!');
      if(room.activeAnnouncement.rowId !== row) return socket.emit('error','Možeš upisati samo kontra polje!');
      const isSolo = room.players.length === 1;
      if(!isSolo && room.activeAnnouncement.playerId === socket.id) return socket.emit('error','Ne možeš kontirati vlastitu najavu!');
    }
    if(!canScore(col,row,cur.scorecard)) return socket.emit('error','Ne možeš upisati tu!');

    if(!room.activeDice) room.activeDice=Array(room.numDice||5).fill(true);
    const activeDice = room.dice.filter((_,i) => room.activeDice[i]);
    if(activeDice.length === 0) return socket.emit('error','Moraš odabrati barem jednu kockicu!');
    cur.scorecard[col][row] = scoreDice(row, activeDice);
    updateTotals(cur);

    if(col==='naj'){
      room.activeAnnouncement = { ...room.announcement };
      room.announcement = null;
    }
    if(col==='kon'){
      const aid = room.activeAnnouncement.playerId;
      const rid2 = room.activeAnnouncement.rowId;
      const soloMode = room.players.length === 1;
      const allDone = soloMode ? cur.scorecard['kon'][rid2]!==undefined : room.players.filter(p=>p.id!==aid).every(p=>p.scorecard['kon'][rid2]!==undefined);
      if(allDone) room.activeAnnouncement = null;
    }

    if(room.players.every(p=>isGameOver(p.scorecard))){
      room.state='finished';
      // ── Spremi statistiku u profile ──────────────────────────────
      const maxScore = Math.max(...room.players.map(p=>p.grandTotal));
      room.players.forEach(rp => {
        const jambs = Object.values(rp.scorecard).reduce((sum, col) => sum + (col['jamb'] > 0 ? 1 : 0), 0);
        updateProfileStats(rp.name, {
          won: rp.grandTotal === maxScore,
          score: rp.grandTotal,
          jambs
        });
      });
      saveRooms(); io.to(roomId).emit('gameOver',room); io.emit('roomList',getRoomList()); return;
    }
    advanceTurn(room);
    saveRooms();
    io.to(roomId).emit('roomUpdate',room);
    // Ako je bot na redu, pokreni bot potez
    scheduleBotTurn(roomId);
  });

  socket.on('chatMessage',({roomId,text})=>{
    const p=players[socket.id],room=rooms[roomId]; if(!p||!room) return;
    touchRoom(roomId);
    const msg={name:p.name,text:text.slice(0,200),ts:Date.now()};
    room.chat.push(msg); if(room.chat.length>80) room.chat.shift();
    io.to(roomId).emit('chatMessage',msg);
  });

  socket.on('reaction',({roomId,emoji})=>{
    const p=players[socket.id],room=rooms[roomId]; if(!p||!room) return;
    const allowed=['👏','😱','🎲','😂','🔥','💀','🏆','😤','YAHTZEE'];
    if(!allowed.includes(emoji)) return;
    io.to(roomId).emit('reaction',{emoji,name:p.name});
  });

  socket.on('leaveRoom',(rid)=>handleLeave(socket,rid));

  socket.on('rematch',(rid)=>{
    const room=rooms[rid]; if(!room||room.host!==socket.id) return;
    if(room.state!=='finished') return;
    // Reset igre — zadrži iste igrače i postavke
    room.state='playing';
    room.currentPlayerIndex=0;
    room.round=1;
    room.activeAnnouncement=null;
    room.announcement=null;
    Object.assign(room, newTurnState(room.numDice));
    // Reset scorecard za svakog igrača
    room.players.forEach(p=>{
      p.scorecard=newScorecard();
      p.colTotals={g:0,d:0,sl:0,naj:0,kon:0};
      p.grandTotal=0;
    });
    saveRooms();
    io.to(rid).emit('rematchStarted', room);
    io.emit('roomList', getRoomList());
  });

  socket.on('disconnect',()=>{
    const p = players[socket.id];
    const token = p?.token;
    const hasSession = token && sessions.has(token);
    if (!hasSession) {
      Object.keys(rooms).forEach(rid=>{if(rooms[rid]?.players.find(rp=>rp.id===socket.id))handleLeave(socket,rid);});
    } else {
      // Ima sesiju — za solo sobu odmah obriši, za multiplayer ostavi (mogu se reconnectat)
      for (const room of Object.values(rooms)) {
        if (room.players.find(rp => rp.id === socket.id)) {
          if (room.maxPlayers === 1) {
            // Solo — daj 30s za reconnect prije brisanja
            const rid = room.id;
            roomTimers.set(rid, setTimeout(() => {
              if (!rooms[rid]) return;
              delete rooms[rid];
              saveRooms();
              io.emit('roomList', getRoomList());
            }, 30 * 1000));
          } else {
            io.to(room.id).emit('playerOffline', { socketId: socket.id, name: p.name });
            // Provjeri ostaju li samo botovi — ako da, zatvori odmah
            const remainingReal = room.players.filter(rp => rp.id !== socket.id && !BOT_IDS.has(rp.id));
            if (remainingReal.length === 0) {
              const rid = room.id;
              delete players[socket.id];
              closeRoomBotOnly(rid);
              return;
            }
            // Ako je owner u lobbyu — pokreni 20s timer za gašenje sobe
            if (room.state === 'lobby' && room.hostProfileToken === p.profileToken) {
              const rid = room.id;
              roomTimers.set(rid, setTimeout(() => {
                const r = rooms[rid];
                if (!r) return;
                console.log(`🗑️  Soba ${rid} zatvorena jer se owner nije vratio`);
                io.to(rid).emit('roomClosed', { reason: `Host se odspojio — soba zatvorena.` });
                io.socketsLeave(rid);
                delete rooms[rid];
                roomTimers.delete(rid);
                saveRooms();
                io.emit('roomList', getRoomList());
              }, 20 * 1000));
            }
          }
          break;
        }
      }
      delete players[socket.id];
      return;
    }
    delete players[socket.id];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT,()=>console.log(`🎲 JAMB server na portu :${PORT}`));