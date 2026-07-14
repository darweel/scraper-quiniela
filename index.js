const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const admin = require('firebase-admin');
const webpush = require('web-push');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://senales-pro-default-rtdb.firebaseio.com'
});
const db = admin.database();

app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

// ══════════════════════════════════════════════════════
// WEB PUSH — avisos con la app cerrada
// ══════════════════════════════════════════════════════
webpush.setVapidDetails(
  'mailto:darweelt@gmail.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const SUBS_FILE = './subscriptions.json';
function cargarSubs() {
  try { return JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')); } catch (e) { return []; }
}
function guardarSubs(subs) {
  fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2));
}

app.post('/subscribe', async (req, res) => {
  const sub = req.body;
  const subs = cargarSubs();
  if (!subs.some((s) => s.endpoint === sub.endpoint)) { subs.push(sub); guardarSubs(subs); }
  res.status(201).json({ ok: true });
});

async function enviarPush(titulo, cuerpo) {
  const subs = cargarSubs();
  const payload = JSON.stringify({ title: titulo, body: cuerpo, url: '/' });
  const vivas = [];
  for (const sub of subs) {
    try { await webpush.sendNotification(sub, payload); vivas.push(sub); }
    catch (e) { if (e.statusCode !== 410 && e.statusCode !== 404) vivas.push(sub); }
  }
  guardarSubs(vivas);
}

async function chequearYAvisar(sorteos) {
  try {
    const snap = await db.ref('watchlist').once('value');
    const watchlist = snap.val() || {};
    if (Object.keys(watchlist).length === 0) return;

    const ahora = new Date();
    const fecha = ahora.toLocaleDateString('es-AR');
    const hora = ahora.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });

    for (const sorteo of Object.keys(sorteos)) {
      for (const prov of Object.keys(sorteos[sorteo])) {
        const numFull = sorteos[sorteo][prov];
        if (!numFull) continue;
        const term = numFull.slice(-2);
        if (!watchlist[term]) continue;

        await db.ref('hits').push({
          num: term, full: numFull, sorteo, prov, fecha, hora, ts: ahora.getTime()
        });
        await enviarPush('🏆 Coincidencia detectada', `El ${numFull} salió en ${sorteo} (${prov})`);
      }
    }
  } catch (err) {
    console.error('Error en chequearYAvisar:', err.message);
  }
}

// ══════════════════════════════════════════════════════
// EXTRACCIÓN REAL — desde la página que da el número
// COMPLETO de 4 cifras por provincia y sorteo
// (https://www.tujugada.com.ar/quiniela-de-hoy.asp)
// ══════════════════════════════════════════════════════
const PROV_MAP = {
  'CIUDAD': 'Nacional',
  'PROVINCIA': 'Provincia',
  'SANTA FE': 'Santa Fe',
  'CORDOBA': 'Córdoba',
  'CÓRDOBA': 'Córdoba',
  'ENTRE RIOS': 'Entre Ríos',
  'ENTRE RÍOS': 'Entre Ríos',
  'URUGUAY': 'Uruguay'
};
const SORTEOS = ['Previa', 'Primera', 'Matutina', 'Vespertina', 'Nocturna'];
const SORTEO_APP = {
  'Previa': 'La Previa',
  'Primera': 'Primera',
  'Matutina': 'Matutina',
  'Vespertina': 'Vespertina',
  'Nocturna': 'Nocturna'
};

function parsearQuinielaDeHoy(texto) {
  const resultado = {};
  Object.values(SORTEO_APP).forEach((s) => (resultado[s] = {}));

  const marcador = texto.indexOf('Resultados del');
  if (marcador < 0) return resultado;
  const finHoy = texto.indexOf('Resultados del', marcador + 1);
  const textoResultados = finHoy > 0 ? texto.slice(marcador, finHoy) : texto.slice(marcador);
  const textoUpper = textoResultados.toUpperCase();

  const provNames = Object.keys(PROV_MAP);
  const posiciones = [];
  provNames.forEach(function (p) {
    const idx = textoUpper.indexOf(p);
    if (idx >= 0) posiciones.push({ nombre: p, idx: idx });
  });
  posiciones.sort((a, b) => a.idx - b.idx);

  for (let i = 0; i < posiciones.length; i++) {
    const inicio = posiciones[i].idx;
    const fin = i + 1 < posiciones.length ? posiciones[i + 1].idx : textoResultados.length;
    const bloque = textoResultados.slice(inicio, fin);
    const provApp = PROV_MAP[posiciones[i].nombre];

    SORTEOS.forEach(function (sorteoWeb) {
      const re = new RegExp(sorteoWeb + '\\s*(\\d{2,4}|-+)', 'i');
      const mm = bloque.match(re);
      if (mm && /^\d+$/.test(mm[1])) {
        resultado[SORTEO_APP[sorteoWeb]][provApp] = mm[1].padStart(4, '0');
      }
    });
  }
  return resultado;
}

async function scrapeQuiniela() {
  try {
    const response = await fetch('https://www.tujugada.com.ar/quiniela-de-hoy.asp', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    const html = await response.text();
    const $ = cheerio.load(html);
    const text = $('body').text().replace(/\s+/g, ' ');

    const sorteos = parsearQuinielaDeHoy(text);

    const tieneAlgunDato = Object.values(sorteos).some(
      (prov) => Object.keys(prov).length > 0
    );

    if (tieneAlgunDato) {
      await db.ref('resultados').set({
        data: sorteos,
        timestamp: Date.now()
      });
      await chequearYAvisar(sorteos);
    } else {
      console.log('Scrape vacío, no se pisan los datos anteriores.');
    }

    return sorteos;
  } catch (err) {
    console.error('Error scraping:', err);
    return null;
  }
}

app.get('/', async (req, res) => {
  const data = await scrapeQuiniela();
  if (data) {
    res.json({ ok: true, data });
  } else {
    res.status(500).json({ ok: false, error: 'Error al scrapear' });
  }
});

// ══════════════════════════════════════════════════════
// DEBUG — ver exactamente qué está recibiendo el scraper
// ══════════════════════════════════════════════════════
app.get('/debug', async (req, res) => {
  try {
    const response = await fetch('https://www.tujugada.com.ar/quiniela-de-hoy.asp', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    const html = await response.text();
    const $ = cheerio.load(html);
    const text = $('body').text().replace(/\s+/g, ' ');

    res.json({
      status: response.status,
      htmlLength: html.length,
      textLength: text.length,
      contieneResultadosDel: text.includes('Resultados del'),
      contieneCIUDAD: text.toUpperCase().includes('CIUDAD'),
      primeros500: text.slice(0, 500),
      alrededorDeResultados: (function () {
        const idx = text.indexOf('Resultados del');
        return idx >= 0 ? text.slice(idx, idx + 300) : 'NO ENCONTRADO';
      })()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log('Puerto ' + PORT));
