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
// EXTRACCIÓN REAL — una página por provincia, con el
// extracto completo de 20 números por sorteo
// ══════════════════════════════════════════════════════
const PROV_URLS = {
  'Nacional':   'https://www.tujugada.com.ar/quiniela-nacional.asp',
  'Provincia':  'https://www.tujugada.com.ar/quiniela_provincia_buenos_aires.asp',
  'Santa Fe':   'https://www.tujugada.com.ar/quiniela_santa_fe.asp',
  'Córdoba':    'https://www.tujugada.com.ar/quiniela_cordoba.asp',
  'Entre Ríos': 'https://www.tujugada.com.ar/quiniela_entre_rios.asp'
};

const SORTEO_APP = {
  'Previa': 'La Previa',
  'Primera': 'Primera',
  'Matutina': 'Matutina',
  'Vespertina': 'Vespertina',
  'Nocturna': 'Nocturna'
};

// Header de cada bloque de sorteo en la página, ej:
// "martes 28/7/2026 - Primera 12:00 hs. 52 - La Madre"
const HEADER_RE = /(Previa|Primera|Matutina|Vespertina|Nocturna)\s*\d{1,2}:\d{2}\s*hs\./gi;

// Reordena los 20 números extraídos en orden de aparición del texto
// (que van intercalados: Ubic1,Ubic11,Ubic2,Ubic12,...) al orden real Ubic 1..20
function reordenarUbicaciones(numsEnOrdenDeTexto) {
  if (numsEnOrdenDeTexto.length !== 20) return numsEnOrdenDeTexto; // fallback: no se puede reordenar con certeza
  const real = new Array(20);
  for (let i = 0; i < 10; i++) {
    real[i] = numsEnOrdenDeTexto[2 * i];       // Ubic (i+1)
    real[i + 10] = numsEnOrdenDeTexto[2 * i + 1]; // Ubic (i+11)
  }
  return real;
}

function parsearPaginaProvincia(texto, provApp, resultado) {
  // Solo nos interesan los sorteos de HOY: la página lista hoy primero
  // y después "Quinielas del [dia anterior]" — cortamos ahí.
  const finHoy = texto.search(/Quinielas del/i);
  const textoHoy = finHoy >= 0 ? texto.slice(0, finHoy) : texto;

  const matches = [...textoHoy.matchAll(HEADER_RE)];
  for (let i = 0; i < matches.length; i++) {
    const sorteoWeb = matches[i][1];
    // clave de deduplicación: nos quedamos con la PRIMERA aparición de cada
    // sorteo (la página lista hoy en orden del más reciente al más viejo,
    // así que la primera vez que aparece "Primera" hoy es la de hoy).
    const sorteoAppKey = SORTEO_APP[
      Object.keys(SORTEO_APP).find((k) => k.toLowerCase() === sorteoWeb.toLowerCase())
    ];
    if (!sorteoAppKey) continue;
    if (resultado[sorteoAppKey][provApp]) continue; // ya lo tenemos (evita pisar con datos viejos)

    const inicioBloque = matches[i].index + matches[i][0].length;
    const finBloque = i + 1 < matches.length ? matches[i + 1].index : textoHoy.length;
    const bloque = textoHoy.slice(inicioBloque, finBloque);

    // Los Ubic van de 1 a 20 (1-2 cifras); los resultados son siempre 4 cifras.
    // Esto ignora automáticamente el mensaje anti-copia que Tujugada mete
    // en la posición 2 de cada tabla, porque ese texto no contiene números de 4 cifras.
    // .slice(0,20): a veces el bloque se extiende hasta la fecha del próximo
    // encabezado ("martes 28/7/2026 - ..."), y el año (4 cifras) se colaría
    // como un número 21 falso si no lo cortamos acá.
    const numeros = (bloque.match(/\b\d{4}\b/g) || []).slice(0, 20);
    if (numeros.length === 0) continue;

    const ordenados = reordenarUbicaciones(numeros);
    resultado[sorteoAppKey][provApp] = {
      cabeza: ordenados[0],       // compatibilidad con el formato viejo (1 solo número)
      extracto: ordenados         // array de 20 números en orden real de Ubicación
    };
  }
}

async function scrapearProvincia(provApp, url, resultado) {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    const html = await response.text();
    const $ = cheerio.load(html);
    const text = $('body').text().replace(/\s+/g, ' ');
    parsearPaginaProvincia(text, provApp, resultado);
  } catch (err) {
    console.error(`Error scrapeando ${provApp} (${url}):`, err.message);
  }
}

async function scrapeQuiniela() {
  const resultado = {};
  Object.values(SORTEO_APP).forEach((s) => (resultado[s] = {}));

  await Promise.all(
    Object.entries(PROV_URLS).map(([provApp, url]) => scrapearProvincia(provApp, url, resultado))
  );

  // Separamos en dos formatos para no romper nada de lo que ya lee el front-end:
  // - dataCabezas: mismo formato viejo, 1 número de 4 cifras por sorteo/provincia
  // - dataExtractos: array de 20 números por sorteo/provincia
  const dataCabezas = {};
  const dataExtractos = {};
  Object.entries(resultado).forEach(([sorteo, provincias]) => {
    dataCabezas[sorteo] = {};
    dataExtractos[sorteo] = {};
    Object.entries(provincias).forEach(([prov, info]) => {
      dataCabezas[sorteo][prov] = info.cabeza;
      dataExtractos[sorteo][prov] = info.extracto;
    });
  });

  const tieneAlgunDato = Object.values(dataCabezas).some(
    (prov) => Object.keys(prov).length > 0
  );

  if (tieneAlgunDato) {
    await db.ref('resultados').set({ data: dataCabezas, timestamp: Date.now() });
    await db.ref('extractos').set({ data: dataExtractos, timestamp: Date.now() });
    await chequearYAvisar(dataCabezas);
  } else {
    console.log('Scrape vacío, no se pisan los datos anteriores.');
  }

  return { cabezas: dataCabezas, extractos: dataExtractos };
}

app.get('/', async (req, res) => {
  const data = await scrapeQuiniela();
  if (data) {
    res.json({ ok: true, data: data.cabezas, extractos: data.extractos });
  } else {
    res.status(500).json({ ok: false, error: 'Error al scrapear' });
  }
});

// ══════════════════════════════════════════════════════
// DEBUG — ver exactamente qué está trayendo el scraper
// de cada provincia
// ══════════════════════════════════════════════════════
app.get('/debug', async (req, res) => {
  const salida = {};
  for (const [provApp, url] of Object.entries(PROV_URLS)) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
      const html = await response.text();
      const $ = cheerio.load(html);
      const text = $('body').text().replace(/\s+/g, ' ');
      const finHoy = text.search(/Quinielas del/i);
      salida[provApp] = {
        status: response.status,
        textLength: text.length,
        contieneHeader: HEADER_RE.test(text),
        primeros500: text.slice(0, 500),
        recorteHoy: (finHoy >= 0 ? text.slice(0, finHoy) : text).slice(0, 800)
      };
    } catch (err) {
      salida[provApp] = { error: err.message };
    }
  }
  res.json(salida);
});

app.listen(PORT, () => console.log('Puerto ' + PORT));
