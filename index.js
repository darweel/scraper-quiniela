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
        await enviarPush('Coincidencia detectada', `El ${numFull} salio en ${sorteo} (${prov})`);
      }
    }
  } catch (err) {
    console.error('Error en chequearYAvisar:', err.message);
  }
}

const MOTOR_URL = process.env.MOTOR_URL || null;
let previoCabezas = {};
let diaActual = new Date().toLocaleDateString('es-AR');

function tipoParaMotor(sorteoApp) {
  const mapa = {
    'La Previa': 'la_previa',
    'Primera': 'primera',
    'Matutina': 'matutina',
    'Vespertina': 'vespertina',
    'Nocturna': 'nocturna',
  };
  return mapa[sorteoApp] || sorteoApp.toLowerCase();
}

async function avisarleAlMotorSiHayNuevos(dataCabezas) {
  if (!MOTOR_URL) return;

  const hoy = new Date().toLocaleDateString('es-AR');
  if (hoy !== diaActual) {
    diaActual = hoy;
    previoCabezas = {};
    try {
      await fetch(`${MOTOR_URL}/api/reset-dia`, { method: 'POST' });
    } catch (err) {
      console.error('Error avisando reset-dia al motor:', err.message);
    }
  }

  for (const [sorteo, provincias] of Object.entries(dataCabezas)) {
    for (const [prov, numFull] of Object.entries(provincias)) {
      if (!numFull) continue;
      const key = `${sorteo}|${prov}`;
      if (previoCabezas[key] === numFull) continue;

      previoCabezas[key] = numFull;
      const termino = numFull.slice(-2);

      try {
        await fetch(`${MOTOR_URL}/api/resultado-nuevo`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fecha: hoy,
            tipo: tipoParaMotor(sorteo),
            numeros: [termino],
          }),
        });
      } catch (err) {
        console.error(`Error avisando al motor (${sorteo}/${prov}):`, err.message);
      }
    }
  }
}

const PROV_URLS = {
  'Nacional':   'https://vivitusuerte.com/pizarra/ciudad',
  'Provincia':  'https://vivitusuerte.com/pizarra/provincia',
  'Cordoba':    'https://vivitusuerte.com/pizarra/cordoba',
  'Santa Fe':   'https://vivitusuerte.com/pizarra/santa+fe',
  'Entre Rios': 'https://vivitusuerte.com/pizarra/entre+rios',
  'Uruguay':    'https://vivitusuerte.com/pizarra/montevideo',
  'Mendoza':    'https://vivitusuerte.com/pizarra/mendoza',
  'Corrientes': 'https://vivitusuerte.com/pizarra/corrientes',
  'Chaco':      'https://vivitusuerte.com/pizarra/chaco',
  'Santiago':   'https://vivitusuerte.com/pizarra/santiago',
  'Neuquen':    'https://vivitusuerte.com/pizarra/neuquen',
  'San Luis':   'https://vivitusuerte.com/pizarra/san+luis',
  'Salta':      'https://vivitusuerte.com/pizarra/salta',
  'Jujuy':      'https://vivitusuerte.com/pizarra/jujuy',
  'Tucuman':    'https://vivitusuerte.com/pizarra/tucuman',
  'Chubut':     'https://vivitusuerte.com/pizarra/chubut',
  'Formosa':    'https://vivitusuerte.com/pizarra/formosa',
  'Misiones':   'https://vivitusuerte.com/pizarra/misiones',
  'Catamarca':  'https://vivitusuerte.com/pizarra/catamarca',
  'San Juan':   'https://vivitusuerte.com/pizarra/san+juan',
  'La Rioja':   'https://vivitusuerte.com/pizarra/la+rioja',
  'Rio Negro':  'https://vivitusuerte.com/pizarra/rio+negro'
};

const SORTEO_NAMES = ['La Previa', 'Primera', 'Matutina', 'Vespertina', 'Nocturna'];
const HEADER_RE = new RegExp('(' + SORTEO_NAMES.join('|') + ')', 'g');
const POS_NUM_RE = /(\d{1,2})\.\s*(\d{4})\b/g;

function parsearPaginaProvincia(texto, provApp, resultado) {
  const matches = [...texto.matchAll(HEADER_RE)];
  for (let i = 0; i < matches.length; i++) {
    const sorteo = matches[i][1];
    if (resultado[sorteo][provApp]) continue;

    const inicio = matches[i].index + matches[i][0].length;
    const fin = i + 1 < matches.length ? matches[i + 1].index : texto.length;
    const bloque = texto.slice(inicio, fin);

    const pares = [...bloque.matchAll(POS_NUM_RE)];
    const arr = new Array(20).fill(null);
    for (const [, posStr, num] of pares) {
      const pos = parseInt(posStr, 10);
      if (pos >= 1 && pos <= 20) arr[pos - 1] = num;
    }
    if (arr[0] === null) continue;

    resultado[sorteo][provApp] = { cabeza: arr[0], extracto: arr };
  }
}

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'es-AR,es;q=0.9',
};

async function scrapearProvincia(provApp, url, resultado) {
  try {
    const response = await fetch(url, { headers: FETCH_HEADERS });
    const html = await response.text();
    const $ = cheerio.load(html);
    const text = $('body').text().replace(/\s+/g, ' ');
    parsearPaginaProvincia(text, provApp, resultado);
  } catch (err) {
    console.error(`Error scrapeando ${provApp} (${url}):`, err.message);
  }
}

const NOTITIMBA_URL = 'https://www.notitimba.com/lots/';

const NOTITIMBA_SORTEO_ORDEN = ['La Previa', 'Primera', 'Matutina', 'Vespertina', 'Nocturna'];

const NOTITIMBA_PROV_MAP = {
  'La Ciudad': 'Nacional',
  'La Provincia': 'Provincia',
  'Santa Fe': 'Santa Fe',
  'Cordoba': 'Cordoba',
  'Entre Rios': 'Entre Rios',
  'Montevideo': 'Uruguay',
};

function fechaHoyDDMM() {
  const partes = new Intl.DateTimeFormat('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    day: '2-digit',
    month: '2-digit',
  }).formatToParts(new Date());
  const dia = partes.find((p) => p.type === 'day').value;
  const mes = partes.find((p) => p.type === 'month').value;
  return `${dia}/${mes}`;
}

async function rasparNotitimba(resultado) {
  try {
    const response = await fetch(NOTITIMBA_URL, { headers: FETCH_HEADERS });
    const html = await response.text();
    const $ = cheerio.load(html);
    const hoyDDMM = fechaHoyDDMM();

    const tablasConDatos = $('table').filter((_, tabla) => {
      const primerasCeldas = $(tabla).find('tr td:first-child, tr th:first-child')
        .map((_, c) => $(c).text().trim()).get();
      return primerasCeldas.some((txt) => NOTITIMBA_PROV_MAP[txt]);
    });

    NOTITIMBA_SORTEO_ORDEN.forEach((sorteo, idxTabla) => {
      const tabla = tablasConDatos.eq(idxTabla);
      if (!tabla.length) return;

      const filas = tabla.find('tr');
      if (!filas.length) return;

      const encabezado = filas.eq(0).find('th,td');
      let colHoy = -1;
      encabezado.each((i, celda) => {
        const txt = $(celda).text().trim();
        if (txt.includes(hoyDDMM)) colHoy = i;
      });
      if (colHoy === -1) return;

      filas.slice(1).each((i, fila) => {
        const celdas = $(fila).find('th,td');
        if (!celdas.length) return;
        const nombreFila = $(celdas[0]).text().trim();
        const provApp = NOTITIMBA_PROV_MAP[nombreFila];
        if (!provApp) return;

        if (resultado[sorteo][provApp]) return;

        const valor = $(celdas[colHoy]).text().trim();
        if (/^\d{4}$/.test(valor)) {
          resultado[sorteo][provApp] = { cabeza: valor, extracto: null };
        }
      });
    });
  } catch (err) {
    console.error('Error scrapeando fuente de respaldo (notitimba):', err.message);
  }
}

async function scrapeQuiniela() {
  const resultado = {};
  SORTEO_NAMES.forEach((s) => (resultado[s] = {}));

  await Promise.all(
    Object.entries(PROV_URLS).map(([provApp, url]) => scrapearProvincia(provApp, url, resultado))
  );

  await rasparNotitimba(resultado);

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
    await avisarleAlMotorSiHayNuevos(dataCabezas);
  } else {
    console.log('Scrape vacio, no se pisan los datos anteriores.');
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

app.get('/debug', async (req, res) => {
  const salida = {};
  for (const [provApp, url] of Object.entries(PROV_URLS)) {
    try {
      const response = await fetch(url, { headers: FETCH_HEADERS });
      const html = await response.text();
      const $ = cheerio.load(html);
      const text = $('body').text().replace(/\s+/g, ' ');
      const matches = [...text.matchAll(HEADER_RE)];

      salida[provApp] = {
        status: response.status,
        textLength: text.length,
        sorteosEncontrados: matches.length,
        titulosEncontrados: matches.map((m) => m[0]),
        contextoPrimerSorteo: matches.length
          ? text.slice(matches[0].index, matches[0].index + 200)
          : null,
        finalDeTexto: matches.length === 0 ? text.slice(-800) : null
      };
    } catch (err) {
      salida[provApp] = { error: err.message };
    }
  }
  res.json(salida);
});

app.listen(PORT, () => console.log('Puerto ' + PORT));
    
