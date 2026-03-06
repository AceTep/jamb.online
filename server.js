const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, 'public')));

const ROW_ORDER = ['r1','r2','r3','r4','r5','r6','max','min','tris','skala_mala','skala_velika','full','poker','jamb'];
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
  const mid = ['tris','skala_mala','skala_velika','full','poker','jamb'].reduce((a,k)=>a+(colSc[k]??0),0);
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
function handleLeave(socket, rid) {
  const room=rooms[rid]; if(!room) return;
  socket.leave(rid);
  room.players=room.players.filter(p=>p.id!==socket.id);
  if(room.players.length===0){delete rooms[rid];}
  else{
    if(room.host===socket.id) room.host=room.players[0].id;
    if(room.currentPlayerIndex>=room.players.length) room.currentPlayerIndex=0;
    io.to(rid).emit('roomUpdate',room);
  }
  saveRooms();
  io.emit('roomList',getRoomList());
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
      const takenOnline = Object.values(players).find(p => p.name.toLowerCase() === key);
      if (takenOnline) {
        return socket.emit('error', `Ime "${trimmed}" je trenutno zauzeto — netko je već prijavljen s tim imenom!`);
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