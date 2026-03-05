const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, 'public')));

const ROWS = ['r1','r2','r3','r4','r5','r6','tris','skala_mala','skala_velika','full','poker','jamb','min','max'];
const COLS = ['g','d','gd','dg'];

function getNextRequired(col, scorecard) {
  const sc = scorecard[col];
  if (col === 'g') {
    const order = ['r1','r2','r3','r4','r5','r6','tris','skala_mala','skala_velika','full','poker','jamb','min','max'];
    return order.find(r => sc[r] === undefined) || null;
  }
  if (col === 'd') {
    const order = ['max','min','jamb','poker','full','skala_velika','skala_mala','tris','r6','r5','r4','r3','r2','r1'];
    return order.find(r => sc[r] === undefined) || null;
  }
  if (col === 'gd') {
    const order = ['r1','r2','r3','r4','r5','r6','tris','skala_mala','skala_velika','full','poker','jamb','min','max'];
    return order.find(r => sc[r] === undefined) || null;
  }
  return null; // dg = slobodni
}

function canScore(col, rowId, scorecard) {
  if (scorecard[col][rowId] !== undefined) return false;
  const next = getNextRequired(col, scorecard);
  if (next === null) return true;
  return next === rowId;
}

function scoreDice(rowId, dice) {
  const counts = Array(7).fill(0);
  dice.forEach(d => counts[d]++);
  const sum = dice.reduce((a,b) => a+b, 0);
  const numMap = { r1:1,r2:2,r3:3,r4:4,r5:5,r6:6 };
  if (numMap[rowId] !== undefined) return dice.filter(d => d === numMap[rowId]).reduce((a,b)=>a+b,0);
  switch(rowId) {
    case 'min': return sum;
    case 'max': return sum;
    case 'tris': return counts.some(c=>c>=3) ? sum+10 : 0;
    case 'skala_mala': return [1,2,3,4,5].every(n=>counts[n]>0) ? 35 : 0;
    case 'skala_velika': return [2,3,4,5,6].every(n=>counts[n]>0) ? 42 : 0;
    case 'full': {
      const vals = counts.map((c,i)=>({c,i})).filter(x=>x.c>0&&x.i>0);
      return vals.length===2&&((vals[0].c===3&&vals[1].c===2)||(vals[0].c===2&&vals[1].c===3)) ? sum+30 : 0;
    }
    case 'poker': return counts.some(c=>c>=4) ? sum+40 : 0;
    case 'jamb': return counts.some(c=>c>=5) ? sum+50 : 0;
    default: return 0;
  }
}

function calcColTotal(colSc) {
  const upper = ['r1','r2','r3','r4','r5','r6'];
  const upSum = upper.reduce((a,k) => a+(colSc[k]??0), 0);
  const bonus = upSum >= 60 ? 30 : 0;
  const max = colSc['max'], min = colSc['min'], ones = colSc['r1'];
  const diff = (max!==undefined&&min!==undefined&&ones!==undefined) ? (max-min)*ones : 0;
  const mid = ['tris','skala_mala','skala_velika','full','poker','jamb'];
  const midSum = mid.reduce((a,k) => a+(colSc[k]??0), 0);
  return upSum + bonus + diff + midSum;
}

function isColComplete(colSc) { return ROWS.every(r => colSc[r] !== undefined); }
function isGameOver(scorecard) { return COLS.every(col => isColComplete(scorecard[col])); }
function newScorecard() { const sc={}; COLS.forEach(c=>{sc[c]={};}); return sc; }
function rollN(n) { return Array.from({length:n},()=>Math.floor(Math.random()*6)+1); }
function newTurnState() { return { dice:[1,1,1,1,1], heldDice:[false,false,false,false,false], rollsLeft:3, hasRolled:false }; }

function newPlayer(id, name) {
  return { id, name, scorecard:newScorecard(), colTotals:{g:0,d:0,gd:0,dg:0}, grandTotal:0 };
}

function createRoom(id, name, hostName, hostId, maxPlayers) {
  return {
    id, name, host:hostId, maxPlayers:maxPlayers||4,
    players:[newPlayer(hostId,hostName)],
    state:'lobby', currentPlayerIndex:0, round:1,
    ...newTurnState(), chat:[], createdAt:Date.now()
  };
}

const rooms = {}, players = {};

function getRoomList() {
  return Object.values(rooms).map(r => ({
    id:r.id, name:r.name, players:r.players.length, maxPlayers:r.maxPlayers,
    state:r.state, playerNames:r.players.map(p=>p.name)
  }));
}

function handleLeave(socket, rid) {
  const room = rooms[rid]; if (!room) return;
  socket.leave(rid);
  room.players = room.players.filter(p=>p.id!==socket.id);
  if (room.players.length===0) { delete rooms[rid]; }
  else {
    if (room.host===socket.id) room.host=room.players[0].id;
    if (room.currentPlayerIndex>=room.players.length) room.currentPlayerIndex=0;
    io.to(rid).emit('roomUpdate', room);
  }
  io.emit('roomList', getRoomList());
}

io.on('connection', (socket) => {
  socket.on('setName', (name) => {
    players[socket.id] = { id:socket.id, name:name.trim().slice(0,20) };
    socket.emit('nameSet', players[socket.id]);
    socket.emit('roomList', getRoomList());
  });
  socket.on('getRooms', () => socket.emit('roomList', getRoomList()));
  socket.on('createRoom', ({roomName,maxPlayers}) => {
    const player=players[socket.id]; if(!player) return;
    const rid=Math.random().toString(36).slice(2,8).toUpperCase();
    rooms[rid]=createRoom(rid,roomName||`${player.name}'s soba`,player.name,socket.id,maxPlayers||4);
    socket.join(rid);
    socket.emit('roomJoined',rooms[rid]);
    io.emit('roomList',getRoomList());
  });
  socket.on('joinRoom', (rid) => {
    const player=players[socket.id], room=rooms[rid];
    if(!player||!room) return socket.emit('error','Soba nije pronađena!');
    if(room.state!=='lobby') return socket.emit('error','Igra je već u tijeku!');
    if(room.players.length>=room.maxPlayers) return socket.emit('error','Soba je puna!');
    if(room.players.find(p=>p.id===socket.id)) { socket.join(rid); return socket.emit('roomJoined',room); }
    room.players.push(newPlayer(socket.id,player.name));
    socket.join(rid);
    socket.emit('roomJoined',room);
    io.to(rid).emit('roomUpdate',room);
    io.emit('roomList',getRoomList());
  });
  socket.on('startGame', (rid) => {
    const room=rooms[rid];
    if(!room||room.host!==socket.id) return;
    room.state='playing'; room.currentPlayerIndex=0; room.round=1;
    Object.assign(room,newTurnState());
    io.to(rid).emit('gameStarted',room);
    io.emit('roomList',getRoomList());
  });
  socket.on('rollDice', (rid) => {
    const room=rooms[rid]; if(!room||room.state!=='playing') return;
    const cur=room.players[room.currentPlayerIndex];
    if(cur.id!==socket.id||room.rollsLeft<=0) return;
    room.dice=room.dice.map((d,i)=>room.heldDice[i]?d:rollN(1)[0]);
    room.rollsLeft--;
    room.hasRolled=true;
    if(room.rollsLeft===0) room.heldDice=[false,false,false,false,false];
    io.to(rid).emit('roomUpdate',room);
  });
  socket.on('toggleHold', ({roomId,index}) => {
    const room=rooms[roomId]; if(!room||room.state!=='playing') return;
    if(room.players[room.currentPlayerIndex].id!==socket.id) return;
    if(!room.hasRolled||room.rollsLeft<=0) return;
    room.heldDice[index]=!room.heldDice[index];
    io.to(roomId).emit('roomUpdate',room);
  });
  socket.on('scoreCategory', ({roomId,col,row}) => {
    const room=rooms[roomId]; if(!room||room.state!=='playing') return;
    const cur=room.players[room.currentPlayerIndex];
    if(cur.id!==socket.id) return;
    if(!room.hasRolled) return socket.emit('error','Prvo baci kockice!');
    if(!canScore(col,row,cur.scorecard)) return socket.emit('error','Ne možeš upisati tu!');
    cur.scorecard[col][row]=scoreDice(row,room.dice);
    cur.colTotals[col]=calcColTotal(cur.scorecard[col]);
    cur.grandTotal=COLS.reduce((a,c)=>a+cur.colTotals[c],0);
    if(room.players.every(p=>isGameOver(p.scorecard))) {
      room.state='finished';
      io.to(roomId).emit('gameOver',room);
      io.emit('roomList',getRoomList());
      return;
    }
    room.currentPlayerIndex=(room.currentPlayerIndex+1)%room.players.length;
    if(room.currentPlayerIndex===0) room.round++;
    Object.assign(room,newTurnState());
    io.to(roomId).emit('roomUpdate',room);
  });
  socket.on('chatMessage', ({roomId,text}) => {
    const player=players[socket.id], room=rooms[roomId];
    if(!player||!room) return;
    const msg={name:player.name,text:text.slice(0,200),ts:Date.now()};
    room.chat.push(msg); if(room.chat.length>80) room.chat.shift();
    io.to(roomId).emit('chatMessage',msg);
  });
  socket.on('leaveRoom', (rid) => handleLeave(socket,rid));
  socket.on('disconnect', () => {
    Object.keys(rooms).forEach(rid => {
      if(rooms[rid]?.players.find(p=>p.id===socket.id)) handleLeave(socket,rid);
    });
    delete players[socket.id];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎲 JAMB server na portu :${PORT}`));
