const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

// Firebase Admin
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://senales-pro-default-rtdb.firebaseio.com'
});
const db = admin.database();

// Guardar token FCM
app.post('/token', async (req, res) => {
  const { token } = req.body;
  if(token) {
    await db.ref('tokens/' + token.slice(-20)).set({ token, ts: Date.now() });
    res.json({ ok: true });
  } else {
    res.json({ ok: false });
  }
});

// Enviar notificación push a todos los tokens
async function sendPush(title, body) {
  try {
    const snap = await db.ref('tokens').once('value');
    const tokens = [];
    snap.forEach(child => tokens.push(child.val().token));
    for(const token of tokens) {
      await admin.messaging().send({
        token,
        notification: { title, body },
        android: { priority: 'high' },
        webpush: { headers: { Urgency: 'high' } }
      }).catch(e => console.log('Token error:', e.message));
    }
  } catch(e) { console.log('Push error:', e.message); }
}

// Guardar señal y enviar push
app.post('/senal', async (req, res) => {
  const { num, repeticiones, sorteo } = req.body;
  await sendPush(
    '🔥 SEÑAL — ' + num + ' llegó a ' + repeticiones + ' repeticiones!',
    'TOP compañeros activados · ' + sorteo
  );
  res.json({ ok: true });
});

// Scraper principal
async function scrapeQuiniela() {
  try {
    const response = await fetch('https://www.tujugada.com.ar/quiniela-de-hoy.asp', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const html = await response.text();
    const $ = cheerio.load(html);
    const text = $('body').text().replace(/\s+/g, ' ');

    const resultado = {
      'La Previa': {}, 'Primera': {}, 'Matutina': {}, 'Vespertina': {}, 'Nocturna': {}
    };

    const provMap = {
      'CIUDAD': 'Nacional', 'PROVINCIA': 'Provincia',
      'SANTA FE': 'Santa Fe', 'CORDOBA': 'Córdoba', 'ENTRE RIOS': 'Entre Ríos'
    };

    const sorteoMap = {
      'Previa': 'La Previa', 'Primera': 'Primera',
      'Matutina': 'Matutina', 'Vespertina': 'Vespertina', 'Nocturna': 'Nocturna'
    };

    Object.keys(provMap).forEach(prov => {
      const idx = text.indexOf(prov);
      if(idx < 0) return;
      const chunk = text.substring(idx, idx + 400);
      Object.keys(sorteoMap).forEach(s => {
        const sIdx = chunk.indexOf(s);
        if(sIdx < 0) return;
        const after = chunk.substring(sIdx + s.length, sIdx + s.length + 20);
        const numMatch = after.match(/(\d{4})/);
        if(numMatch) resultado[sorteoMap[s]][provMap[prov]] = numMatch[1];
      });
    });

    return { ok: true, data: resultado, ts: new Date().toISOString() };
  } catch(e) {
    return { ok: false, error: e.message };
  }
}

app.get('/', async (req, res) => {
  const data = await scrapeQuiniela();
  res.json(data);
});

app.listen(PORT, () => console.log('Puerto ' + PORT));
