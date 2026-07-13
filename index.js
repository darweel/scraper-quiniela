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
        const term = sorteos[sorteo][prov];
        if (!term || !watchlist[term]) continue;

        await db.ref('hits').push({
          num: term, full: term, sorteo, prov, fecha, hora, ts: ahora.getTime()
        });
        await enviarPush('🏆 Coincidencia detectada', `El ${term} salió en ${sorteo} (${prov})`);
      }
    }
  } catch (err) {
    console.error('Error en chequearYAvisar:', err.message);
  }
}

// ══════════════════════════════════════════════════════
// EXTRACCIÓN REAL — ancorada al nombre de cada sorteo,
// en vez de contar posiciones de números sueltos en la página
// (la página muestra "CIUDAD: Nocturna el 28 (El cerro)..." )
// ══════════════════════════════════════════════════════
const PROV_MAP = {
  'CIUDAD': 'Nacional',
  'PROVINCIA': 'Provincia',
  'SANTA FE': 'Santa Fe',
  'CORDOBA': 'Córdoba',
  'CÓRDOBA': 'Córdoba',
  'ENTRE RIOS': 'Entre Ríos',
  'ENTRE RÍOS': 'Entre Ríos'
};
const SORTEO_MAP = {
  'Previa': 'La Previa',
  'Primera': 'Primera',
  'Matutina': 'Matutina',
  'Vespertina': 'Vespertina',
  'Nocturna': 'Nocturna'
};

function parsearCabezas(textoCompleto) {
  const resultado = {};
  Object.values(SORTEO_MAP).forEach((s) => (resultado[s] = {}));

  // Tomar SOLO la primera sección "CABEZAS EN LAS QUINIELAS DEL ..."
  // (la página lista el día actual primero, y después días anteriores completos;
  //  si no cortamos acá, los datos de ayer pisan a los de hoy).
  const partes = textoCompleto.split(/CABEZAS EN LAS QUINIELAS DEL/i);
  if (partes.length < 2) return resultado; // no encontró el patrón esperado
  const seccionHoy = partes[1]; // todo lo que sigue hasta la próxima ocurrencia (o fin)

  const provNames = Object.keys(PROV_MAP).join('|');
  const bloqueRegex = new RegExp('(' + provNames + '):\\s*([^.]*\\.)', 'g');
  let m;
  while ((m = bloqueRegex.exec(seccionHoy)) !== null) {
    const provWeb = m[1];
    const contenido = m[2];
    const provApp = PROV_MAP[provWeb];
    if (!provApp) continue;

    Object.keys(SORTEO_MAP).forEach(function (sorteoWeb) {
      const re = new RegExp(sorteoWeb + '\\s+el\\s+(\\d{2})', 'i');
      const mm = contenido.match(re);
      if (mm) {
        resultado[SORTEO_MAP[sorteoWeb]][provApp] = mm[1];
      }
    });
  }
  return resultado;
}

async function scrapeQuiniela() {
  try {
    const response = await fetch('https://www.tujugada.com.ar', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    const html = await response.text();
    const $ = cheerio.load(html);
    const text = $('body').text().replace(/\s+/g, ' ');

    const sorteos = parsearCabezas(text);

    // Guardar en Firebase
    await db.ref('resultados').set({
      data: sorteos,
      timestamp: Date.now()
    });

    // Avisar si algo de la watchlist salió
    await chequearYAvisar(sorteos);

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

app.listen(PORT, () => console.log('Puerto ' + PORT));
