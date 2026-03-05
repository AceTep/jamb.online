const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

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
function newTurnState() {
  return { dice:[1,1,1,1,1], heldDice:[false,false,false,false,false], rollsLeft:3, hasRolled:false, announcement:null };
}
function newPlayer(id, name) {
  return { id, name, scorecard:newScorecard(), colTotals:{g:0,d:0,sl:0,naj:0,kon:0}, grandTotal:0 };
}
function createRoom(id, name, hostId, hostName, maxPlayers) {
  return { id, name, host:hostId, maxPlayers:maxPlayers||4,
    players:[newPlayer(hostId,hostName)], state:'lobby',
    currentPlayerIndex:0, round:1, ...newTurnState(),
    activeAnnouncement:null, chat:[] };
}
function advanceTurn(room) {
  room.currentPlayerIndex = (room.currentPlayerIndex+1) % room.players.length;
  if (room.currentPlayerIndex === 0) room.round++;
  const prevAnn = room.activeAnnouncement;
  Object.assign(room, newTurnState());
  room.activeAnnouncement = prevAnn;
}

const rooms = {}, players = {};
function getRoomList() {
  return Object.values(rooms).map(r=>({id:r.id,name:r.name,players:r.players.length,maxPlayers:r.maxPlayers,state:r.state,playerNames:r.players.map(p=>p.name)}));
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
  io.emit('roomList',getRoomList());
}

io.on('connection',(socket)=>{
  socket.on('setName',(name)=>{
    players[socket.id]={id:socket.id,name:name.trim().slice(0,20)};
    socket.emit('nameSet',players[socket.id]);
    socket.emit('roomList',getRoomList());
  });
  socket.on('getRooms',()=>socket.emit('roomList',getRoomList()));
  socket.on('createRoom',({roomName,maxPlayers})=>{
    const p=players[socket.id]; if(!p) return;
    const rid=Math.random().toString(36).slice(2,8).toUpperCase();
    rooms[rid]=createRoom(rid,roomName||`${p.name}'s soba`,socket.id,p.name,maxPlayers||4);
    socket.join(rid); socket.emit('roomJoined',rooms[rid]); io.emit('roomList',getRoomList());
  });
  socket.on('joinRoom',(rid)=>{
    const p=players[socket.id],room=rooms[rid];
    if(!p||!room) return socket.emit('error','Soba nije pronađena!');
    if(room.state!=='lobby') return socket.emit('error','Igra je već u tijeku!');
    if(room.players.length>=room.maxPlayers) return socket.emit('error','Soba je puna!');
    if(room.players.find(x=>x.id===socket.id)){socket.join(rid);return socket.emit('roomJoined',room);}
    room.players.push(newPlayer(socket.id,p.name));
    socket.join(rid); socket.emit('roomJoined',room);
    io.to(rid).emit('roomUpdate',room); io.emit('roomList',getRoomList());
  });
  socket.on('startGame',(rid)=>{
    const room=rooms[rid]; if(!room||room.host!==socket.id) return;
    room.state='playing'; room.currentPlayerIndex=0; room.round=1;
    room.activeAnnouncement=null; Object.assign(room,newTurnState());
    io.to(rid).emit('gameStarted',room); io.emit('roomList',getRoomList());
  });

  // Najava: odabir PRIJE prvog bacanja
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
    const room=rooms[rid]; if(!room||room.state!=='playing') return;
    const cur=room.players[room.currentPlayerIndex];
    if(cur.id!==socket.id||room.rollsLeft<=0) return;
    room.dice=room.dice.map((d,i)=>room.heldDice[i]?d:rollN(1)[0]);
    room.rollsLeft--;
    room.hasRolled=true;
    if(room.rollsLeft===0) room.heldDice=[false,false,false,false,false];
    io.to(rid).emit('roomUpdate',room);
  });

  socket.on('toggleHold',({roomId,index})=>{
    const room=rooms[roomId]; if(!room||room.state!=='playing') return;
    if(room.players[room.currentPlayerIndex].id!==socket.id) return;
    if(!room.hasRolled||room.rollsLeft<=0) return;
    room.heldDice[index]=!room.heldDice[index];
    io.to(roomId).emit('roomUpdate',room);
  });

  socket.on('scoreCategory',({roomId,col,row})=>{
    const room=rooms[roomId]; if(!room||room.state!=='playing') return;
    const cur=room.players[room.currentPlayerIndex];
    if(cur.id!==socket.id) return socket.emit('error','Nije tvoj red!');
    if(!room.hasRolled) return socket.emit('error','Prvo baci kockice!');

    // ── Provjera: je li igrač obavezan upisati kontru ovaj potez?
    const mustKontra = room.activeAnnouncement && room.activeAnnouncement.playerId !== socket.id
                       && cur.scorecard['kon'][room.activeAnnouncement.rowId] === undefined;

    // ── Provjera: je li igrač najavil/a i mora upisati u najava stupac?
    const mustNajava = !!room.announcement;

    // ── Ako moram upisati kontru, ne mogu nigdje drugdje
    if(mustKontra){
      if(col !== 'kon') return socket.emit('error','Kontra je aktivna — moraš upisati u ⚡ Kontra stupac!');
      if(row !== room.activeAnnouncement.rowId) return socket.emit('error',`Moraš upisati kontra za: ${room.activeAnnouncement.rowId}!`);
    }

    // ── Ako sam najavil/a, moram upisati samo u naj stupac
    if(mustNajava){
      if(col !== 'naj') return socket.emit('error','Najavil/a si polje — moraš upisati u 📢 Najava stupac!');
      if(row !== room.announcement.rowId) return socket.emit('error','Možeš upisati samo najavljeno polje!');
    }

    // ── Najava stupac: mora biti aktivna najava
    if(col==='naj' && !room.announcement) return socket.emit('error','Nisi najavil/a polje!');
    if(col==='naj' && row !== room.announcement.rowId) return socket.emit('error','Možeš upisati samo najavljeno polje!');

    // ── Kontra stupac: mora biti aktivan activeAnnouncement, ne može vlastiti
    if(col==='kon'){
      if(!room.activeAnnouncement) return socket.emit('error','Nema aktivne najave za kontru!');
      if(room.activeAnnouncement.rowId !== row) return socket.emit('error','Možeš upisati samo kontra polje!');
      if(room.activeAnnouncement.playerId === socket.id) return socket.emit('error','Ne možeš kontirati vlastitu najavu!');
    }

    if(!canScore(col,row,cur.scorecard)) return socket.emit('error','Ne možeš upisati tu!');

    cur.scorecard[col][row] = scoreDice(row, room.dice);
    updateTotals(cur);

    // Najava upisana → postaje activeAnnouncement za kontru
    if(col==='naj'){
      room.activeAnnouncement = { ...room.announcement };
      room.announcement = null;
    }
    // Kontra upisana → provjeri jesu li svi upisali
    if(col==='kon'){
      const aid = room.activeAnnouncement.playerId;
      const rid2 = room.activeAnnouncement.rowId;
      const allDone = room.players.filter(p=>p.id!==aid).every(p=>p.scorecard['kon'][rid2]!==undefined);
      if(allDone) room.activeAnnouncement = null;
    }

    if(room.players.every(p=>isGameOver(p.scorecard))){
      room.state='finished'; io.to(roomId).emit('gameOver',room); io.emit('roomList',getRoomList()); return;
    }
    advanceTurn(room);
    io.to(roomId).emit('roomUpdate',room);
  });

  socket.on('chatMessage',({roomId,text})=>{
    const p=players[socket.id],room=rooms[roomId]; if(!p||!room) return;
    const msg={name:p.name,text:text.slice(0,200),ts:Date.now()};
    room.chat.push(msg); if(room.chat.length>80) room.chat.shift();
    io.to(roomId).emit('chatMessage',msg);
  });
  socket.on('leaveRoom',(rid)=>handleLeave(socket,rid));
  socket.on('disconnect',()=>{
    Object.keys(rooms).forEach(rid=>{if(rooms[rid]?.players.find(p=>p.id===socket.id))handleLeave(socket,rid);});
    delete players[socket.id];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT,()=>console.log(`🎲 JAMB server na portu :${PORT}`));
