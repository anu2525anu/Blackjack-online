const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ===== Constante =====
const SUITS = ['hearts','diamonds','clubs','spades'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const SYMBOLS = { hearts:'♥', diamonds:'♦', clubs:'♣', spades:'♠' };
const START_BANKROLL = 10000;
const MAX_PLAYERS = 10;

function cardValue(r){ if(['J','Q','K'].includes(r)) return 10; if(r==='A') return 11; return parseInt(r); }

function buildShoe(decks){
const shoe=[];
for(let d=0; d<decks; d++)
for(const s of SUITS)
for(const r of RANKS)
shoe.push({ rank:r, symbol:SYMBOLS[s], value:cardValue(r),
isRed: s==='hearts'||s==='diamonds', isHidden:false });
for(let i=shoe.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [shoe[i],shoe[j]]=[shoe[j],shoe[i]]; }
return shoe;
}

function score(cards){
let s=0, aces=0;
for(const c of cards){ if(c.isHidden) continue; s+=c.value; if(c.rank==='A') aces++; }
while(s>21 && aces>0){ s-=10; aces--; }
return s;
}
function isBJ(cards){ return cards.length===2 && !cards.some(c=>c.isHidden) && score(cards)===21; }

const rooms = {};

function genRoomId(){
let id;
do { id = Math.random().toString(36).slice(2,7).toUpperCase(); } while(rooms[id]);
return id;
}

function broadcast(room){ io.to(room.id).emit('state', publicState(room)); }

function publicState(room){
return {
id: room.id, state: room.state, hostId: room.hostId,
dealer: room.dealer.map(c => ({...c})),
dealerScore: score(room.dealer),
players: room.players.map(p => ({
id: p.id, name: p.name, bankroll: p.bankroll,
hand: p.hand.map(c => ({...c})),
score: score(p.hand), bet: p.bet, ready: p.ready,
isBJ: isBJ(p.hand), outcome: p.outcome || null
})),
currentIdx: room.currentIdx,
};
}

function ensureShoe(room){
if(room.shoe.length < 20) room.shoe = buildShoe(room.decks);
}

function startRound(room){
if(room.state !== 'BETTING') return;
if(room.players.some(p => p.bet <= 0)) return;
ensureShoe(room);
room.state = 'PLAYING';
room.dealer = [];
room.currentIdx = 0;

room.players.forEach(p => {
p.hand = []; p.ready = false; p.outcome = null;
p.bankroll -= p.bet;
});

// 2 cărți fiecărui jucător, 2 dealerului (alternat)
for(let round = 0; round < 2; round++){
for(const p of room.players) p.hand.push(room.shoe.pop());
room.dealer.push(room.shoe.pop());
}
room.dealer[1].isHidden = true;

// BJ = auto-stand
for(const p of room.players) if(isBJ(p.hand)) p.hand.length && (p._stood = true);

advanceTurn(room);
broadcast(room);
}

function advanceTurn(room){
// Găsește următorul care nu e stood și nu are 21
while(room.currentIdx < room.players.length){
const p = room.players[room.currentIdx];
if(p._stood || score(p.hand) >= 21) { room.currentIdx++; continue; }
break;
}

if(room.currentIdx >= room.players.length){
startDealerTurn(room);
}
}

function startDealerTurn(room){
room.state = 'DEALER';
const hole = room.dealer.find(c => c.isHidden);
if(hole) hole.isHidden = false;
broadcast(room);
setTimeout(() => dealerPlay(room), 800);
}

function dealerPlay(room){
const allBust = room.players.every(p => score(p.hand) > 21);
const dS = score(room.dealer);
if(!allBust && dS < 17){
room.dealer.push(room.shoe.pop());
broadcast(room);
setTimeout(() => dealerPlay(room), 800);
return;
}
resolveRound(room);
}

function resolveRound(room){
const dS = score(room.dealer);
const dBJ = isBJ(room.dealer);
const results = [];
for(const p of room.players){
const pS = score(p.hand), pBJ = isBJ(p.hand);
let payout = 0, outcome = '';
if(pS > 21){ outcome = 'Bust'; }
else if(dBJ && pBJ){ outcome = 'Push'; payout = p.bet; }
else if(dBJ){ outcome = 'Lose'; }
else if(pBJ){ outcome = 'BJ'; payout = Math.floor(p.bet * 2.5); }
else if(dS > 21 || pS > dS){ outcome = 'Win'; payout = p.bet * 2; }
else if(pS === dS){ outcome = 'Push'; payout = p.bet; }
else { outcome = 'Lose'; }
p.bankroll += payout;
p.outcome = outcome;
p.bet = 0;
p._stood = false;
results.push({ name: p.name, outcome, payout });
}
room.state = 'DONE';
broadcast(room);
io.to(room.id).emit('round-over', { results, dealerScore: dS });

setTimeout(() => {
if(!rooms[room.id]) return;
room.state = 'BETTING';
room.dealer = [];
room.players.forEach(p => { p.hand = []; p.outcome = null; p._stood = false; });
broadcast(room);
}, 5000);
}

io.on('connection', socket => {
socket.on('create-room', ({ name, decks }, cb) => {
if(!name || !name.trim()) return cb({ ok: false, err: 'Nume obligatoriu' });
decks = Math.max(2, Math.min(8, parseInt(decks) || 6));
const id = genRoomId();
const room = {
id, hostId: socket.id, decks,
shoe: buildShoe(decks),
players: [{ id: socket.id, name: name.trim().slice(0,20),
bankroll: START_BANKROLL, hand: [], bet: 0, ready: false }],
dealer: [], state: 'BETTING', currentIdx: 0,
};
rooms[id] = room;
socket.join(id);
socket.data.roomId = id;
cb({ ok: true, roomId: id });
broadcast(room);
});

socket.on('join-room', ({ name, roomId }, cb) => {
if(!name || !name.trim()) return cb({ ok: false, err: 'Nume obligatoriu' });
roomId = (roomId || '').toUpperCase().trim();
const room = rooms[roomId];
if(!room) return cb({ ok: false, err: 'Camera nu există' });
if(room.players.length >= MAX_PLAYERS) return cb({ ok: false, err: 'Cameră plină' });
if(room.state === 'PLAYING' || room.state === 'DEALER') return cb({ ok: false, err: 'Runda e în curs. Încearcă după.' });
room.players.push({ id: socket.id, name: name.trim().slice(0,20),
bankroll: START_BANKROLL, hand: [], bet: 0, ready: false });
socket.join(roomId);
socket.data.roomId = roomId;
cb({ ok: true, roomId });
broadcast(room);
});

socket.on('place-bet', ({ amount }) => {
const room = rooms[socket.data.roomId];
if(!room || room.state !== 'BETTING') return;
const p = room.players.find(x => x.id === socket.id);
if(!p) return;
amount = Math.max(0, Math.min(p.bankroll, parseInt(amount) || 0));
p.bet = amount;
p.ready = false;
broadcast(room);
});

socket.on('ready', () => {
const room = rooms[socket.data.roomId];
if(!room || room.state !== 'BETTING') return;
const p = room.players.find(x => x.id === socket.id);
if(!p || p.bet <= 0) return;
p.ready = true;
broadcast(room);
if(room.players.length >= 1 && room.players.every(pl => pl.ready && pl.bet > 0)){
setTimeout(() => startRound(room), 900);
}
});

socket.on('action', ({ action }) => {
const room = rooms[socket.data.roomId];
if(!room || room.state !== 'PLAYING') return;
const p = room.players[room.currentIdx];
if(!p || p.id !== socket.id) return;

if(action === 'H'){
p.hand.push(room.shoe.pop());
if(score(p.hand) >= 21) p._stood = true;
} else if(action === 'S'){
p._stood = true;
} else if(action === 'D'){
if(p.hand.length !== 2 || p.bankroll < p.bet) return;
p.bankroll -= p.bet;
p.bet *= 2;
p.hand.push(room.shoe.pop());
p._stood = true;
}
advanceTurn(room);
broadcast(room);
});

socket.on('disconnect', () => {
const roomId = socket.data.roomId;
const room = rooms[roomId];
if(!room) return;
const idx = room.players.findIndex(p => p.id === socket.id);
if(idx === -1) return;

const wasCurrent = room.state === 'PLAYING' && room.currentIdx === idx;
room.players.splice(idx, 1);

if(idx < room.currentIdx) room.currentIdx--;
if(room.hostId === socket.id && room.players.length > 0) room.hostId = room.players[0].id;

if(room.players.length === 0){
delete rooms[roomId];
return;
}
if(wasCurrent && room.state === 'PLAYING') advanceTurn(room);
broadcast(room);
});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, function() { console.log('BJ Pro server on port ' + PORT); });
