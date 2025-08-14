// script.js (module)
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getDatabase, ref, push, onChildAdded, onValue, set, onDisconnect, remove, serverTimestamp, query, limitToLast
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';

// ========= Init Firebase =========
if(typeof firebaseConfig === 'undefined') {
  alert('Please fill firebase-config.js with your Firebase config.');
  throw new Error('Missing firebaseConfig');
}
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// ========= Room & local id =========
const room = (location.hash?.slice(1) || 'lop46');
document.getElementById('roomName').textContent = room;
let clientId = localStorage.getItem('chaotic_id');
if(!clientId){ clientId = crypto.randomUUID(); localStorage.setItem('chaotic_id', clientId); }

// ========= UI elements =========
const overlay = document.getElementById('overlay');
const nameInput = document.getElementById('nameInput');
const roomInput = document.getElementById('roomInput');
const joinBtn = document.getElementById('joinBtn');
const guestBtn = document.getElementById('guestBtn');
const shareBtn = document.getElementById('shareBtn');
const playerCountEl = document.getElementById('playerCount');
const playerListEl = document.getElementById('playerList');
const toastEl = document.getElementById('toast');

const colorEl = document.getElementById('color');
const sizeEl = document.getElementById('size');
const penBtn = document.getElementById('penBtn');
const eraserBtn = document.getElementById('eraserBtn');
const eraseLeftEl = document.getElementById('eraseLeft');
const cdEl = document.getElementById('cd');
const clearLocalBtn = document.getElementById('clearLocal');

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

// ========= Canvas sizing =========
function fitCanvas(){
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  canvas.width = Math.floor(canvas.clientWidth * dpr);
  canvas.height = Math.floor(canvas.clientHeight * dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);
}
window.addEventListener('resize', fitCanvas);
fitCanvas();

// ========= App state =========
let username = '';
let drawing = false;
let last = null;
let tool = 'pen'; // 'pen' | 'eraser'

// Eraser rules
const ERASE_RADIUS = 18;
const ERASE_BUDGET_MAX = 1200; // pixels per use
const ERASE_COOLDOWN = 45; // seconds
let eraseBudget = ERASE_BUDGET_MAX;
let cooldown = 0;
let cdTimer = null;

// ========= Presence / database refs =========
const playersRef = ref(db, `rooms/${room}/players`);
const strokesRef = ref(db, `rooms/${room}/strokes`);
const eventsRef = ref(db, `rooms/${room}/events`);

// ========= Join & presence =========
joinBtn.addEventListener('click', () => {
  const nm = nameInput.value.trim();
  const r = roomInput.value.trim();
  if(r) { location.hash = r; /* reload to set room*/ location.reload(); return; }
  if(!nm){ showToast('Nhập tên trước khi vào.'); return; }
  username = nm;
  enterRoom();
});

guestBtn.addEventListener('click', () => {
  username = 'anon-' + Math.floor(Math.random()*9000 + 1000);
  enterRoom();
});

function enterRoom(){
  overlay.style.display = 'none';
  // write presence
  const pRef = ref(db, `rooms/${room}/players/${clientId}`);
  set(pRef, { name: username, t: Date.now() });
  onDisconnect(pRef).remove();

  // update last-seen heartbeat
  setInterval(()=> set(pRef, { name: username, t: Date.now() }), 20_000);

  // listen players
  onValue(playersRef, snap => {
    const v = snap.val() || {};
    renderPlayers(v);
  });

  // listen strokes/events
  onChildAdded(strokesRef, snap => {
    const s = snap.val(); if(!s) return;
    drawSegment(s, false);
  });
  onChildAdded(eventsRef, snap => {
    const e = snap.val(); if(!e) return;
    if(e.type === 'erase-notify') showToast(`${e.by} đã tẩy!`);
    if(e.type === 'clear-board') {
      ctx.clearRect(0,0,canvas.width,canvas.height);
      showToast('Board đã bị xóa bởi admin');
    }
  });
}

// render players & count
function renderPlayers(obj){
  playerListEl.innerHTML = '';
  const arr = Object.entries(obj || {}).map(([id,v]) => ({ id, name: v.name }));
  playerCountEl.textContent = arr.length;
  arr.forEach(p => {
    const el = document.createElement('span');
    el.className = 'playerTag';
    el.textContent = p.name;
    playerListEl.appendChild(el);
  });
}

// ========= Drawing primitives =========
function line(a,b,opt){
  ctx.save();
  if(opt.eraser){
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineWidth = opt.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  } else {
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = opt.color;
    ctx.lineWidth = opt.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  ctx.restore();
}

function drawSegment(s, local){
  // s: { a:{x,y}, b:{x,y}, color, size, eraser, by, t }
  line(s.a, s.b, { color: s.color || '#000', size: s.size || 6, eraser: !!s.eraser });
  // if local==true we already drew; otherwise it was remote
}

// send to firebase
function pushStroke(a,b,opt){
  push(strokesRef, {
    a, b, color: opt.color, size: opt.size, eraser: !!opt.eraser, by: username, t: serverTimestamp()
  });
}

// ========= Pointer events =========
function getPos(e){
  const r = canvas.getBoundingClientRect();
  const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
  const y = (e.touches ? e.touches[0].clientY : e.clientY) - r.top;
  return { x, y };
}

canvas.addEventListener('pointerdown', (ev) => {
  if(!username){ showToast('Bạn chưa nhập tên!'); return; }
  drawing = true;
  last = getPos(ev);
  canvas.setPointerCapture(ev.pointerId);
});

canvas.addEventListener('pointermove', (ev) => {
  if(!drawing) return;
  const p = getPos(ev);
  if(tool === 'pen'){
    const seg = { color: colorEl.value, size: parseInt(sizeEl.value,10), eraser: false };
    line(last, p, seg);
    pushStroke(last, p, seg);
  } else if(tool === 'eraser'){
    // decrement budget by distance
    const dx = p.x - last.x, dy = p.y - last.y;
    const dist = Math.sqrt(dx*dx + dy*dy);
    eraseBudget -= dist;
    const seg = { color: null, size: ERASE_RADIUS, eraser: true };
    line(last, p, seg);
    pushStroke(last, p, seg);
    // if announce eraser (send event once per use)
    if(!toolUsedAnnounced){ announceEraser(); toolUsedAnnounced = true; }
    if(eraseBudget <= 0){
      eraseBudget = 0;
      startCooldown();
      setTool('pen');
      showToast('Hết lượt tẩy! Đang cooldown 45s');
    }
    updateCooldownUI();
  }
  last = p;
});

let toolUsedAnnounced = false;

canvas.addEventListener('pointerup', (ev) => {
  drawing = false;
  last = null;
  canvas.releasePointerCapture?.(ev.pointerId);
  toolUsedAnnounced = false;
});

// mouse leave
canvas.addEventListener('pointercancel', () => { drawing = false; last = null; toolUsedAnnounced = false; });

// ========= Tools UI =========
penBtn.addEventListener('click', ()=> setTool('pen'));
eraserBtn.addEventListener('click', tryUseEraser);

function setTool(t){
  tool = t;
  if(t === 'pen'){
    penBtn.classList.add('primary'); eraserBtn.classList.remove('primary');
  } else {
    penBtn.classList.remove('primary'); eraserBtn.classList.add('primary');
  }
}

// Eraser flow
function tryUseEraser(){
  if(cooldown > 0){
    showToast(`Tẩy đang cooldown ${cooldown}s`);
    return;
  }
  if(eraseBudget <= 0){
    showToast('Hết lượt tẩy, bắt đầu cooldown');
    startCooldown();
    return;
  }
  setTool('eraser');
}

// announce erase event to room (so everyone sees who erased)
function announceEraser(){
  push(eventsRef, { type: 'erase-notify', by: username, t: serverTimestamp() });
}

// cooldown logic
function startCooldown(){
  cooldown = ERASE_COOLDOWN;
  eraseBudget = 0;
  if(cdTimer) clearInterval(cdTimer);
  cdTimer = setInterval(()=>{
    cooldown -= 1;
    if(cooldown <= 0){
      cooldown = 0;
      eraseBudget = ERASE_BUDGET_MAX;
      clearInterval(cdTimer); cdTimer = null;
      showToast('Đã nạp lại lượt tẩy!');
    }
    updateCooldownUI();
  }, 1000);
  updateCooldownUI();
}

function updateCooldownUI(){
  eraseLeftEl.textContent = Math.max(0, Math.floor(eraseBudget));
  cdEl.textContent = cooldown;
}

// ========= Send & receive stroke history (last N) =========
// Optionally load last N strokes to catch up
const recentQuery = query(strokesRef, limitToLast(1000));
onChildAdded(recentQuery, snap => {
  const s = snap.val(); if(!s) return;
  // draw existing strokes (they will also trigger normal onChildAdded; duplicates possible but acceptable)
  drawSegment(s,false);
});

// ========= Share / clear local =========
shareBtn.addEventListener('click', ()=> {
  const link = location.href.split('#')[0] + '#' + room;
  navigator.clipboard.writeText(link).then(()=> showToast('Đã copy link phòng'));
});
clearLocalBtn.addEventListener('click', ()=> {
  if(confirm('Chỉ xoá canvas trên máy bạn (không xóa online). Tiếp tục?')){
    ctx.clearRect(0,0,canvas.width,canvas.height);
  }
});

// Admin clear (optional) - you can implement admin logic; here we listen to clear events in eventsRef
// ... already handled in onChildAdded for events

// ========= Toast =========
let toastTimer = null;
function showToast(msg){
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=> toastEl.classList.remove('show'), 1800);
}

// ========= Unload: remove presence =========
window.addEventListener('beforeunload', () => {
  const pRef = ref(db, `rooms/${room}/players/${clientId}`);
  remove(pRef).catch(()=>{});
});

// ========= Init small UI defaults =========
setTool('pen');
eraseLeftEl.textContent = ERASE_BUDGET_MAX;
cdEl.textContent = 0;
updateCooldownUI();
