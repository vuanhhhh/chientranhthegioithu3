// script.js (module)
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getDatabase, ref, push, onChildAdded, onValue, set, onDisconnect, remove, serverTimestamp, query, limitToLast
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';

// ========= Init Firebase =========
// Use global window.firebaseConfig placed by firebase-config.js
if(!window.firebaseConfig){
  alert('Missing Firebase config (firebase-config.js). Please add it.');
  throw new Error('Missing firebaseConfig');
}
const app = initializeApp(window.firebaseConfig);
const db = getDatabase(app);

// ========= Room & local id =========
const room = (location.hash?.slice(1) || 'lop46');
const roomNameEl = document.getElementById('roomName');
if(roomNameEl) roomNameEl.textContent = room;
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
  if(r) { location.hash = r; location.reload(); return; }
  if(!nm){ showToast('Nhập tên trước khi vào.'); return; }
  username = nm;
  enterRoom();
});

guestBtn.addEventListener('click', () => {
  username = 'anon-' + Math.floor(Math.random()*9000 + 1000);
  enterRoom();
});

function enterRoom(){
  if(overlay) overlay.style.display = 'none';
  const pRef = ref(db, `rooms/${room}/players/${clientId}`);
  set(pRef, { name: username, t: Date.now() });
  const od = onDisconnect(pRef);
  od.remove();
  // heartbeat
  setInterval(()=> set(pRef, { name: username, t: Date.now() }), 20_000);

  onValue(playersRef, snap => {
    const v = snap.val() || {};
    renderPlayers(v);
  });

  // listen strokes (last 2000) and new ones
  const recentQuery = query(strokesRef, limitToLast(2000));
  onChildAdded(recentQuery, snap => {
    const s = snap.val(); if(!s) return;
    drawSegment(s);
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

function renderPlayers(obj){
  if(!playerListEl || !playerCountEl) return;
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
  } else {
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = opt.color;
    ctx.lineWidth = opt.size;
  }
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  ctx.restore();
}

function drawSegment(s){
  line(s.a, s.b, { color: s.color || '#000', size: s.size || 6, eraser: !!s.eraser });
}

function pushStroke(a,b,opt){
  push(strokesRef, {
    a, b, color: opt.color, size: opt.size, eraser: !!opt.eraser, by: username, t: serverTimestamp()
  });
}

// ========= Position helpers =========
function getPos(e){
  const r = canvas.getBoundingClientRect();
  let x, y;
  if(e.touches && e.touches[0]){
    x = e.touches[0].clientX - r.left;
    y = e.touches[0].clientY - r.top;
  } else {
    x = e.clientX - r.left;
    y = e.clientY - r.top;
  }
  return { x, y };
}

// ========= Drawing logic =========
let toolUsedAnnounced = false;

function startDraw(e){
  if(!username){ showToast('Bạn chưa nhập tên!'); return; }
  drawing = true;
  last = getPos(e);
  // prevent page scroll/zoom while drawing
  try { e.preventDefault(); } catch(_) {}
}
function moveDraw(e){
  if(!drawing) return;
  const p = getPos(e);
  if(!last) last = p;
  if(tool === 'pen'){
    const seg = { color: colorEl.value, size: parseInt(sizeEl.value,10), eraser: false };
    line(last, p, seg);
    pushStroke(last, p, seg);
  } else if(tool === 'eraser'){
    const dx = p.x - last.x, dy = p.y - last.y;
    const dist = Math.sqrt(dx*dx + dy*dy);
    eraseBudget -= dist;
    const seg = { color: null, size: ERASE_RADIUS, eraser: true };
    line(last, p, seg);
    pushStroke(last, p, seg);
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
  try { e.preventDefault(); } catch(_) {}
}
function endDraw(){
  drawing = false;
  last = null;
  toolUsedAnnounced = false;
}

// Pointer (desktop)
canvas.addEventListener('pointerdown', startDraw);
canvas.addEventListener('pointermove', moveDraw);
canvas.addEventListener('pointerup', endDraw);
canvas.addEventListener('pointercancel', endDraw);

// Touch fallback (mobile)
canvas.addEventListener('touchstart', startDraw, { passive:false });
canvas.addEventListener('touchmove', moveDraw, { passive:false });
canvas.addEventListener('touchend', endDraw, { passive:false });

// ========= Tools UI =========
if (penBtn) penBtn.addEventListener('click', ()=> setTool('pen'));
if (eraserBtn) eraserBtn.addEventListener('click', tryUseEraser);

function setTool(t){
  tool = t;
  if(t === 'pen'){
    penBtn?.classList.add('primary'); eraserBtn?.classList.remove('primary');
  } else {
    penBtn?.classList.remove('primary'); eraserBtn?.classList.add('primary');
  }
}

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

function announceEraser(){
  push(eventsRef, { type: 'erase-notify', by: username, t: serverTimestamp() });
}

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
  if(eraseLeftEl) eraseLeftEl.textContent = Math.max(0, Math.floor(eraseBudget));
  if(cdEl) cdEl.textContent = cooldown;
}

// ========= Recent history (limit) =========
// already set above in enterRoom using query + onChildAdded

// ========= Share / clear local =========
if(shareBtn) shareBtn.addEventListener('click', ()=> {
  const link = location.href.split('#')[0] + '#' + room;
  navigator.clipboard.writeText(link).then(()=> showToast('Đã copy link phòng'));
});
if(clearLocalBtn) clearLocalBtn.addEventListener('click', ()=> {
  if(confirm('Chỉ xoá canvas trên máy bạn (không xóa online). Tiếp tục?')){
    ctx.clearRect(0,0,canvas.width,canvas.height);
  }
});

// ========= Toast =========
let toastTimer = null;
function showToast(msg){
  if(!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=> toastEl.classList.remove('show'), 1800);
}

// ========= Remove presence on leave =========
window.addEventListener('beforeunload', () => {
  try {
    const pRef = ref(db, `rooms/${room}/players/${clientId}`);
    remove(pRef).catch(()=>{});
  } catch(e){}
});

// ========= Init defaults =========
setTool('pen');
if(eraseLeftEl) eraseLeftEl.textContent = ERASE_BUDGET_MAX;
if(cdEl) cdEl.textContent = 0;
updateCooldownUI();
