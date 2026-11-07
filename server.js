import express from 'express';
import { pipeline, RawImage } from '@xenova/transformers';

const app = express();
const API_KEY = process.env.API_KEY || 'changeme';
const NTFY_TOPIC = process.env.NTFY_TOPIC || '';   // optionnel
const clients = new Set();
let lastJpeg = null, busy = false, lastAlert = 0, detector = null;

// Le modèle se charge en arrière-plan (téléchargé automatiquement)
pipeline('object-detection', 'Xenova/yolos-tiny').then(d => {
  detector = d;
  console.log('Modèle prêt');
});

function send(event, data) {
  for (const c of clients) c.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
setInterval(() => send('ping', {}), 25000);

// Réception des photos de l'ESP32
app.post('/api/esp/photo',
  express.raw({ type: 'image/jpeg', limit: '2mb' }),
  async (req, res) => {
    if (req.headers['x-api-key'] !== API_KEY) return res.sendStatus(401);
    lastJpeg = req.body;
    res.send('ok');
    if (!detector || busy) return;          // on saute la photo si le serveur est occupé
    busy = true;
    try {
      const img = await RawImage.fromBlob(new Blob([req.body], { type: 'image/jpeg' }));
      const out = await detector(img, { threshold: 0.6 });
      const persons = out.filter(o => o.label === 'person');
      send('status', { person: persons.length > 0, count: persons.length });
      if (persons.length && Date.now() - lastAlert > 30000) {   // 1 alerte max / 30 s
        lastAlert = Date.now();
        send('alert', { count: persons.length });
        if (NTFY_TOPIC) {
          fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
            method: 'POST',
            body: 'Personne détectée par la caméra',
            headers: { Title: 'ESP32-CAM' }
          }).catch(() => {});
        }
      }
    } catch (e) { console.error(e); }
    finally { busy = false; }
  });

app.get('/last.jpg', (req, res) => {
  if (!lastJpeg) return res.sendStatus(404);
  res.type('image/jpeg').send(lastJpeg);
});

app.get('/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

app.use(express.static('public'));
app.listen(process.env.PORT || 3000, () => console.log('Serveur démarré'));
