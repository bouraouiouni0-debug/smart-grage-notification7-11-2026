// server.js : serveur complet pour le sketch smart_garage_detection.ino
//  - relais page web <-> ESP32 (poll, messages, photo à la demande)
//  - détection de personne faite ICI (pas sur l'ESP32) + notification sur le PC
//
// Variables d'environnement Render :
//   ESP_KEY     (obligatoire) la même que dans le sketch
//   VIEW_PASS   (recommandé)  mot de passe pour ouvrir les pages (le navigateur le demande une fois)
//   NTFY_TOPIC  (optionnel)   nom unique pour recevoir aussi la notif via https://ntfy.sh/<nom>

import express from 'express';
import { pipeline, RawImage } from '@xenova/transformers';

const app = express();
const PORT = process.env.PORT || 3000;
const ESP_KEY = process.env.ESP_KEY || "esp1234"; 
const VIEW_PASS = process.env.VIEW_PASS || '';
const NTFY_TOPIC = process.env.NTFY_TOPIC || '';
const ALERT_COOLDOWN_MS = 30000;   // 1 notification max toutes les 30 s

// ===================== ETAT =====================
let lastSeen = 0;                  // dernière fois que l'ESP32 a parlé au serveur
let captureRequested = false;      // le navigateur veut une photo
let captureWaiters = [];           // navigateurs en attente de la photo
let toEsp = [];                    // messages navigateur -> ESP32
let toBrowser = [];                // messages ESP32 -> navigateur

let detector = null;
let busy = false;
let lastDetectJpeg = null;
let lastAlert = 0;
const sseClients = new Set();

// ===================== PAGES =====================
const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ESP32 CAM CONTROL</title>
<style>
* { box-sizing: border-box; }
body { margin: 0; padding: 20px; background: #101827; color: white; font-family: Arial, sans-serif; }
.container { max-width: 600px; margin: auto; }
h1 { text-align: center; color: #38bdf8; }
.status { text-align: center; margin: 15px; color: #f87171; }
.status.on { color: #4ade80; }
.card { background: #1e293b; padding: 20px; margin-top: 18px; border-radius: 14px; }
button { width: 100%; padding: 15px; margin-top: 12px; background: #0284c7; border: none; color: white; border-radius: 9px; font-size: 16px; font-weight: bold; cursor: pointer; }
button:active { background: #0369a1; }
input { width: 100%; padding: 14px; margin-top: 10px; border: none; border-radius: 8px; font-size: 16px; }
#photo { width: 100%; margin-top: 15px; border-radius: 10px; display: none; }
#messages { background: #0f172a; min-height: 150px; max-height: 250px; overflow-y: auto; padding: 12px; border-radius: 8px; margin-top: 10px; overflow-wrap: anywhere; }
.msg { padding: 10px; margin-bottom: 8px; background: #334155; border-radius: 7px; }
.sent { border-left: 4px solid #38bdf8; }
.received { border-left: 4px solid #4ade80; }
</style>
</head>
<body>
<div class="container">

<h1>ESP32-CAM CONTROL</h1>
<div class="status" id="status">● ESP32 OFFLINE</div>

<div class="card">
  <h3>📷 CAMERA</h3>
  <button id="photoBtn" onclick="takePhoto()">TAKE A PHOTO</button>
  <img id="photo" alt="Captured photo">
</div>

<div class="card">
  <h3>🚨 PERSON DETECTION</h3>
  <button onclick="location.href='/detect'">OPEN DETECTION PAGE</button>
</div>

<div class="card">
  <h3>📤 SEND MESSAGE TO ESP32</h3>
  <input id="messageInput" type="text" placeholder="Write your message...">
  <button onclick="sendMessage()">SEND MESSAGE</button>
</div>

<div class="card">
  <h3>🎲 RANDOM VALUE (0-100)</h3>
  <button id="autoBtn" onclick="toggleAuto()">AUTO SEND: ON</button>
</div>

<div class="card">
  <h3>📥 RECEIVE MESSAGES FROM ESP32</h3>
  <div id="messages"></div>
</div>

</div>

<script>
async function takePhoto() {
  const photo = document.getElementById("photo");
  const btn = document.getElementById("photoBtn");
  btn.disabled = true;
  addMessage("Taking photo...", "sent");
  try {
    const response = await fetch("/api/capture?t=" + Date.now());
    if (!response.ok) throw new Error(await response.text());
    const blob = await response.blob();
    const oldURL = photo.dataset.url;
    const newURL = URL.createObjectURL(blob);
    photo.src = newURL;
    photo.style.display = "block";
    photo.onload = function () { if (oldURL) URL.revokeObjectURL(oldURL); };
    photo.dataset.url = newURL;
    addMessage("Photo received successfully!", "received");
  } catch (error) {
    addMessage("Photo error: " + error.message, "received");
  }
  btn.disabled = false;
}

async function sendMessage() {
  const input = document.getElementById("messageInput");
  const msg = input.value.trim();
  if (msg === "") return;
  try {
    const response = await fetch("/api/send?msg=" + encodeURIComponent(msg));
    if (!response.ok) throw new Error("Send failed");
    await response.text();
    addMessage("YOU: " + msg, "sent");
    input.value = "";
  } catch (error) {
    addMessage("Error: " + error.message, "received");
  }
}

async function sendRandom() {
  const value = Math.floor(Math.random() * 101);
  try {
    const response = await fetch("/api/send?msg=" + value);
    if (!response.ok) throw new Error("Send failed");
    await response.text();
    addMessage("YOU: random value " + value, "sent");
  } catch (error) {
    addMessage("Error: " + error.message, "received");
  }
}

let autoTimer = setInterval(sendRandom, 3000);

function toggleAuto() {
  const btn = document.getElementById("autoBtn");
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
    btn.textContent = "AUTO SEND: OFF";
  } else {
    sendRandom();
    autoTimer = setInterval(sendRandom, 3000);
    btn.textContent = "AUTO SEND: ON";
  }
}

document.getElementById("messageInput").addEventListener("keydown", function (event) {
  if (event.key === "Enter") sendMessage();
});

function addMessage(text, type) {
  const div = document.createElement("div");
  div.className = "msg " + type;
  div.textContent = text;
  const box = document.getElementById("messages");
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

async function receiveMessage() {
  try {
    const response = await fetch("/api/receive?t=" + Date.now());
    if (!response.ok) return;
    const message = await response.text();
    if (message.length > 0) addMessage("ESP32: " + message, "received");
  } catch (error) { console.log(error); }
}

async function checkStatus() {
  const s = document.getElementById("status");
  try {
    const r = await fetch("/api/status?t=" + Date.now());
    const j = await r.json();
    s.textContent = j.online ? "● ESP32 ONLINE" : "● ESP32 OFFLINE";
    s.className = j.online ? "status on" : "status";
  } catch (e) {
    s.textContent = "● ESP32 OFFLINE";
    s.className = "status";
  }
}

setInterval(receiveMessage, 1000);
setInterval(checkStatus, 2000);
receiveMessage();
checkStatus();
</script>
</body>
</html>`;

const DETECT_HTML = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Détection de personne</title>
<style>
body{margin:0;padding:20px;background:#101827;color:#fff;font-family:Arial,sans-serif;text-align:center}
#s{font-size:22px;margin:16px}
#s.on{color:#f87171}
button{padding:12px 20px;border:0;border-radius:8px;background:#0284c7;color:#fff;font-size:16px;cursor:pointer;margin:4px}
img{max-width:100%;width:640px;border-radius:10px;margin-top:16px;display:none}
</style></head><body>
<h2>🎥 Détection de personne</h2>
<button id="b">Activer les notifications</button>
<button onclick="location.href='/'">Retour</button>
<div id="s">En attente de la caméra…</div>
<div id="t"></div>
<img id="i" alt="">
<script>
document.getElementById('b').onclick = function () { Notification.requestPermission(); };
var es = new EventSource('/detect/events');
es.addEventListener('status', function (e) {
  var d = JSON.parse(e.data);
  var s = document.getElementById('s');
  s.textContent = d.person ? '👤 Personne détectée (' + d.count + ')' : '✅ Rien à signaler';
  s.className = d.person ? 'on' : '';
  document.getElementById('t').textContent = 'Dernière analyse : ' + new Date().toLocaleTimeString();
  var i = document.getElementById('i');
  i.style.display = 'inline-block';
  i.src = '/detect/last.jpg?t=' + Date.now();
});
es.addEventListener('alert', function () {
  if (Notification.permission === 'granted') {
    new Notification('🚨 Personne détectée !', { body: new Date().toLocaleTimeString() });
  }
});
</script></body></html>`;

// ===================== SECURITE =====================
// Pages protégées par mot de passe (si VIEW_PASS est défini). L'ESP32 utilise x-api-key.
app.use((req, res, next) => {
  if (!VIEW_PASS || req.path.startsWith('/api/esp/')) return next();
  const h = req.headers.authorization || '';
  if (h.startsWith('Basic ')) {
    const decoded = Buffer.from(h.slice(6), 'base64').toString();
    if (decoded.slice(decoded.indexOf(':') + 1) === VIEW_PASS) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="ESP32-CAM"').status(401).send('Authentification requise');
});

function espAuth(req, res, next) {
  if (!ESP_KEY || req.headers['x-api-key'] !== ESP_KEY) return res.sendStatus(401);
  next();
}

// ===================== ROUTES ESP32 =====================
// L'ESP32 interroge le serveur toutes les 2 s : "1" = photo demandée, puis les messages du navigateur
app.get('/api/esp/poll', espAuth, (req, res) => {
  lastSeen = Date.now();
  const cap = captureRequested ? '1' : '0';
  captureRequested = false;
  const msgs = toEsp.splice(0);
  res.type('text/plain').send(cap + '\n' + msgs.join('\n'));
});

// Photo demandée par le navigateur (avec flash)
app.post('/api/esp/photo', espAuth, express.raw({ type: 'image/jpeg', limit: '3mb' }), (req, res) => {
  lastSeen = Date.now();
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.sendStatus(400);
  res.send('ok');
  const waiters = captureWaiters;
  captureWaiters = [];
  waiters.forEach(fn => fn(req.body));
});

// Messages ESP32 -> navigateur
app.post('/api/esp/message', espAuth, express.text({ type: '*/*', limit: '10kb' }), (req, res) => {
  lastSeen = Date.now();
  const t = String(req.body || '').trim();
  if (t) {
    toBrowser.push(t);
    if (toBrowser.length > 50) toBrowser.shift();
  }
  res.send('ok');
});

// Images pour la détection de personne (sans flash, toutes les 3 s)
app.post('/api/esp/detect', espAuth, express.raw({ type: 'image/jpeg', limit: '3mb' }), async (req, res) => {
  lastSeen = Date.now();
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.sendStatus(400);
  lastDetectJpeg = req.body;
  res.send('ok');                          // on répond tout de suite à l'ESP32

  if (!detector || busy) return;           // modèle pas prêt ou déjà occupé : on saute cette image
  busy = true;
  try {
    const img = await RawImage.fromBlob(new Blob([req.body], { type: 'image/jpeg' }));
    const out = await detector(img, { threshold: 0.6 });
    const persons = out.filter(o => o.label === 'person');
    sseSend('status', { person: persons.length > 0, count: persons.length });

    if (persons.length > 0 && Date.now() - lastAlert > ALERT_COOLDOWN_MS) {
      lastAlert = Date.now();
      console.log('[detect] personne détectée');
      sseSend('alert', { count: persons.length });
      if (NTFY_TOPIC) {
        fetch('https://ntfy.sh/' + NTFY_TOPIC, {
          method: 'POST',
          body: 'Personne détectée par la caméra',
          headers: { Title: 'ESP32-CAM' }
        }).catch(() => {});
      }
    }
  } catch (e) {
    console.error('[detect] erreur analyse:', e);
  } finally {
    busy = false;
  }
});

// ===================== ROUTES NAVIGATEUR =====================
app.get('/', (req, res) => res.type('html').send(INDEX_HTML));

app.get('/api/status', (req, res) => {
  res.json({ online: Date.now() - lastSeen < 6000 });
});

app.get('/api/receive', (req, res) => {
  res.type('text/plain').send(toBrowser.shift() || '');
});

app.get('/api/send', (req, res) => {
  const m = String(req.query.msg || '').replace(/[\r\n]+/g, ' ').trim();
  if (!m) return res.status(400).send('Missing message');
  toEsp.push(m);
  if (toEsp.length > 20) toEsp.shift();
  res.send('Message sent to ESP32');
});

app.get('/api/capture', (req, res) => {
  if (Date.now() - lastSeen > 10000) return res.status(503).send('ESP32 offline');
  captureRequested = true;
  const timer = setTimeout(() => {
    captureWaiters = captureWaiters.filter(f => f !== done);
    res.status(504).send('ESP32 did not answer');
  }, 25000);
  function done(buf) {
    clearTimeout(timer);
    res.set('Cache-Control', 'no-store');
    res.type('image/jpeg').send(buf);
  }
  captureWaiters.push(done);
});

// ===================== PAGE DE DETECTION =====================
function sseSend(event, data) {
  for (const c of sseClients) c.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
}
setInterval(() => sseSend('ping', {}), 25000);

app.get('/detect', (req, res) => res.type('html').send(DETECT_HTML));

app.get('/detect/last.jpg', (req, res) => {
  if (!lastDetectJpeg) return res.sendStatus(404);
  res.set('Cache-Control', 'no-store');
  res.type('image/jpeg').send(lastDetectJpeg);
});

app.get('/detect/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ===================== DEMARRAGE =====================
app.listen(PORT, () => console.log('Serveur démarré sur le port ' + PORT));

// Le modèle se charge en arrière-plan (téléchargé automatiquement)
pipeline('object-detection', 'Xenova/yolos-tiny')
  .then(d => { detector = d; console.log('[detect] modèle prêt'); })
  .catch(e => console.error('[detect] erreur chargement modèle:', e));
