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

// Las suscripciones ahora se guardan TAMBIÉN en Firebase (/pushSubs).
// El archivo local de Render se borra cada vez que el servicio se duerme
// o reinicia — por eso antes las notificaciones dejaban de llegar.
const crypto = require('crypto');
function idSub(sub) {
  return crypto.createHash('sha1').update(String(sub && sub.endpoint)).digest('hex');
}

app.post('/subscribe', async (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ ok: false });
  const subs = cargarSubs();
  if (!subs.some((s) => s.endpoint === sub.endpoint)) { subs.push(sub); guardarSubs(subs); }
  try { await db.ref('pushSubs/' + idSub(sub)).set({ sub, alta: Date.now() }); }
  catch (e) { console.error('No se pudo guardar la suscripción en Firebase:', e.message); }
  res.status(201).json({ ok: true });
});

async function enviarPush(titulo, cuerpo) {
  const porEndpoint = {};
  cargarSubs().forEach((s) => { if (s && s.endpoint) porEndpoint[s.endpoint] = s; });
  try {
    const snap = await db.ref('pushSubs').once('value');
    Object.values(snap.val() || {}).forEach((x) => { if (x && x.sub && x.sub.endpoint) porEndpoint[x.sub.endpoint] = x.sub; });
  } catch (e) { console.error('No se pudieron leer las suscripciones de Firebase:', e.message); }
  const payload = JSON.stringify({ title: titulo, body: cuerpo, url: '/' });
  const vivas = [];
  for (const sub of Object.values(porEndpoint)) {
    try { await webpush.sendNotification(sub, payload); vivas.push(sub); }
    catch (e) {
      if (e.statusCode !== 410 && e.statusCode !== 404) vivas.push(sub);
      else { try { await db.ref('pushSubs/' + idSub(sub)).remove(); } catch (e2) {} }
    }
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
// MOTOR NUEVO (Señales Pro Engine v2, en Render) — cada vez
// que aparece un resultado nuevo se lo avisamos para que
// pueda descartarlo de las sugerencias de voz del día.
// Configurar MOTOR_URL en las variables de entorno de Render.
// Si no está seteada, el scraper sigue funcionando igual,
// solo que sin avisarle al motor nuevo (no rompe nada viejo).
// ══════════════════════════════════════════════════════
const MOTOR_URL = process.env.MOTOR_URL || null;

// Jugada del día en el servidor (ver jugadas.js)
const jugadas = require('./jugadas.js')({ db, fetch, enviarPush, motorUrl: MOTOR_URL });
let previoCabezas = {}; // snapshot del último scrape, para detectar qué es realmente nuevo
let diaActual = new Date().toLocaleDateString('es-AR');

function tipoParaMotor(sorteoApp) {
  // Nombres del scraper -> nombres que espera el motor (sin espacios, sin tildes)
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
    // Cambió el día — arrancamos de cero para el motor también
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
      if (previoCabezas[key] === numFull) continue; // ya lo habíamos avisado

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

// ══════════════════════════════════════════════════════
// EXTRACCIÓN REAL — Viví tu Suerte: una página por PROVINCIA
// (vivitusuerte.com/pizarra/<slug>), con los 5 turnos y el
// extracto completo de 20 números para cada uno. Cubre 22
// jurisdicciones (antes solo teníamos 6 con Jugando Online).
// ══════════════════════════════════════════════════════
const PROV_URLS = {
  'Nacional':   'https://vivitusuerte.com/pizarra/ciudad',
  'Provincia':  'https://vivitusuerte.com/pizarra/provincia',
  'Córdoba':    'https://vivitusuerte.com/pizarra/cordoba',
  'Santa Fe':   'https://vivitusuerte.com/pizarra/santa+fe',
  'Entre Ríos': 'https://vivitusuerte.com/pizarra/entre+rios',
  'Uruguay':    'https://vivitusuerte.com/pizarra/montevideo',
  'Mendoza':    'https://vivitusuerte.com/pizarra/mendoza',
  'Corrientes': 'https://vivitusuerte.com/pizarra/corrientes',
  'Chaco':      'https://vivitusuerte.com/pizarra/chaco',
  'Santiago':   'https://vivitusuerte.com/pizarra/santiago',
  'Neuquén':    'https://vivitusuerte.com/pizarra/neuquen',
  'San Luis':   'https://vivitusuerte.com/pizarra/san+luis',
  'Salta':      'https://vivitusuerte.com/pizarra/salta',
  'Jujuy':      'https://vivitusuerte.com/pizarra/jujuy',
  'Tucumán':    'https://vivitusuerte.com/pizarra/tucuman',
  'Chubut':     'https://vivitusuerte.com/pizarra/chubut',
  'Formosa':    'https://vivitusuerte.com/pizarra/formosa',
  'Misiones':   'https://vivitusuerte.com/pizarra/misiones',
  'Catamarca':  'https://vivitusuerte.com/pizarra/catamarca',
  'San Juan':   'https://vivitusuerte.com/pizarra/san+juan',
  'La Rioja':   'https://vivitusuerte.com/pizarra/la+rioja',
  'Río Negro':  'https://vivitusuerte.com/pizarra/rio+negro'
};

const SORTEO_NAMES = ['La Previa', 'Primera', 'Matutina', 'Vespertina', 'Nocturna'];
const HEADER_RE = new RegExp('(' + SORTEO_NAMES.join('|') + ')', 'g');
// "1. 1206" / "11. 1782" — posición + número de 4 cifras. Los sorteos que
// todavía no salieron muestran "----" en vez de un número, y esa posición
// simplemente no matchea (no hace falta filtrarla a mano).
const POS_NUM_RE = /(\d{1,2})\.\s*(\d{4,5})\b/g;

// Algunos sorteos particulares (ej: Santa Fe Nocturna) publican 5 cifras en vez
// de 4. Normalizamos siempre a 4 dígitos (los últimos 4), que es el formato
// que usa el resto de la app.
function normalizarNum(num) {
  return num.length === 5 ? num.slice(-4) : num;
}

function parsearPaginaProvincia(texto, provApp, resultado) {
  const matches = [...texto.matchAll(HEADER_RE)];
  for (let i = 0; i < matches.length; i++) {
    const sorteo = matches[i][1];
    if (resultado[sorteo][provApp]) continue; // ya lo tenemos (primera aparición = hoy)

    const inicio = matches[i].index + matches[i][0].length;
    const fin = i + 1 < matches.length ? matches[i + 1].index : texto.length;
    const bloque = texto.slice(inicio, fin);

    const pares = [...bloque.matchAll(POS_NUM_RE)];
    const arr = new Array(20).fill(null);
    for (const [, posStr, num] of pares) {
      const pos = parseInt(posStr, 10);
      if (pos >= 1 && pos <= 20) arr[pos - 1] = normalizarNum(num);
    }
    if (arr[0] === null) continue; // sin cabeza todavía, no hay nada real que guardar

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

// ══════════════════════════════════════════════════════
// FUENTE DE RESPALDO — NotiTimba (www.notitimba.com/lots)
// Página con URL FIJA (no cambia todos los días como Ámbito
// o Cronista), con una tabla por turno y una columna por día.
// Solo se usa para RELLENAR los huecos que deja la fuente
// principal (vivitusuerte) — nunca pisa un dato que ya vino
// bien de ahí. Solo trae la "cabeza" (no el extracto completo
// de 20 números), pero es mejor que nada cuando la fuente
// principal todavía no publicó ese sorteo.
// ══════════════════════════════════════════════════════
const NOTITIMBA_URL = 'https://www.notitimba.com/lots/';

// Orden de las 5 tablas en la página, de arriba a abajo
// (coincide con el desplegable del sitio: La previa, El
// primero, Matutina, Vespertina, Nocturna).
const NOTITIMBA_SORTEO_ORDEN = ['La Previa', 'Primera', 'Matutina', 'Vespertina', 'Nocturna'];

// Nombre de la fila en la tabla -> nombre que usa nuestra app
const NOTITIMBA_PROV_MAP = {
  'La Ciudad': 'Nacional',
  'La Provincia': 'Provincia',
  'Santa Fe': 'Santa Fe',
  'Córdoba': 'Córdoba',
  'Entre Ríos': 'Entre Ríos',
  'Montevideo': 'Uruguay',
};

function fechaHoyDDMM() {
  // Fecha de hoy en horario Argentina, formato "DD/MM"
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
    const response = await fetch(NOTITIMBA_URL, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(5000) });
    const html = await response.text();
    const $ = cheerio.load(html);
    const hoyDDMM = fechaHoyDDMM();

    // No confiamos en la posición fija de la tabla dentro de la página
    // (el sitio tiene tablas decorativas antes/después de las 5 que nos
    // importan). En cambio, nos quedamos solo con las tablas que tienen
    // alguna fila cuya primera celda sea el nombre de una provincia
    // conocida — esas son, en orden, La Previa/Primera/Matutina/
    // Vespertina/Nocturna, tal cual las lista el propio sitio.
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

      // Fila de encabezado: buscamos en qué columna está la fecha de hoy
      const encabezado = filas.eq(0).find('th,td');
      let colHoy = -1;
      encabezado.each((i, celda) => {
        const txt = $(celda).text().trim();
        if (txt.includes(hoyDDMM)) colHoy = i;
      });
      if (colHoy === -1) return; // hoy no está en la tabla (ej: no hay sorteo, como los domingos)

      filas.slice(1).each((i, fila) => {
        const celdas = $(fila).find('th,td');
        if (!celdas.length) return;
        const nombreFila = $(celdas[0]).text().trim();
        const provApp = NOTITIMBA_PROV_MAP[nombreFila];
        if (!provApp) return; // fila de una provincia que no usamos

        if (resultado[sorteo][provApp]) return; // ya lo tenemos de la fuente principal, no se pisa

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

  // Fuente de respaldo: rellena solo lo que la principal no trajo
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
    console.log('Scrape vacío, no se pisan los datos anteriores.');
  }

  return { cabezas: dataCabezas, extractos: dataExtractos };
}

app.get('/', async (req, res) => {
  const data = await scrapeQuiniela();
  // Procesa la Jugada del día de fondo (no demora la respuesta al celular)
  jugadas.procesar(data && data.cabezas).catch((e) => console.error('jugadas:', e.message));
  if (data) {
    res.json({ ok: true, data: data.cabezas, extractos: data.extractos });
  } else {
    res.status(500).json({ ok: false, error: 'Error al scrapear' });
  }
});

// ══════════════════════════════════════════════════════
// TICK — lo llama cron-job.org cada 5 minutos. Mantiene despierto
// el servicio, scrapea y procesa la Jugada del día aunque no haya
// ningún celular con la app abierta.
// ══════════════════════════════════════════════════════
app.get('/tick', async (req, res) => {
  try {
    const data = await scrapeQuiniela();
    const r = await jugadas.procesar(data && data.cabezas);
    res.json(r);
  } catch (e) {
    console.error('Error en /tick:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════
// DEBUG
// ══════════════════════════════════════════════════════
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

// ══════════════════════════════════════════════════════
// SUGERENCIA DE IA — 3 números sugeridos según el
// historial de señales activas de los últimos 14 días.
// Requiere la variable de entorno ANTHROPIC_API_KEY.
// ══════════════════════════════════════════════════════
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const FIREBASE_URL = 'https://senales-pro-default-rtdb.firebaseio.com';

// Guarda la última sugerencia en memoria para no llamar a la IA
// en cada visita — se recalcula solo si pasaron más de 2 horas.
let cacheSugerencia = { numeros: [], texto: '', calculadoEn: 0 };
const DOS_HORAS = 2 * 60 * 60 * 1000;

// ══════════════════════════════════════════════════════
// PROMPT — módulo de selección inteligente, cruce con
// Compañeros del Sueño / repetición 3+ / Pendientes.
// NOTA: la parte de "Pendientes" queda preparada pero sin
// datos todavía — falta definir de dónde salen esos datos
// (ver aviso en calcularSugerenciaIA).
// ══════════════════════════════════════════════════════
const PROMPT_BASE = `Sos el módulo de selección inteligente de Señales Pro.

Tu función NO es predecir resultados de quiniela ni calcular probabilidades reales.
Cada sorteo es independiente y ninguna señal, repetición, compañero o pendiente
garantiza que un número vaya a salir.

Debés seleccionar 3 números de TERMINACIÓN (00 a 99) utilizando exclusivamente
los datos y señales que te proporciona el sistema.

La selección debe basarse en el CRUCE de la metodología propia de Señales Pro,
dando prioridad a la combinación de:

1. COMPAÑEROS DEL SUEÑO:
   Números relacionados mediante la base histórica propia de "Compañeros del
   Sueño". Si una terminación señalada recientemente tiene compañeros presentes
   en los datos recibidos, considerá ese vínculo como una señal de selección.

2. REPETICIÓN 3+:
   Cuando una terminación se haya repetido 3 o más veces durante la semana,
   sus Compañeros del Sueño reciben prioridad dentro del análisis.

3. PENDIENTES:
   Considerá las terminaciones marcadas por el sistema como "Pendientes",
   especialmente cuando también aparecen relacionadas con señales recientes o
   con Compañeros del Sueño. (Si no se reciben datos de Pendientes, ignorá este punto.)

4. HISTORIAL DE SEÑALES:
   Utilizá las señales recientes únicamente como contexto para encontrar cruces
   entre las tres fuentes anteriores. NO selecciones números simplemente porque
   aparecieron más veces.

REGLA PRINCIPAL:
Un número debe recibir mayor valoración cuando exista una CONFLUENCIA de señales,
por ejemplo:
- aparece como compañero de una señal reciente;
- además está relacionado con una terminación que tuvo repetición 3+;
- además figura como pendiente;
- o reúne varias de estas condiciones.

No inventes compañeros, pendientes, frecuencias ni relaciones que no estén
presentes en los datos proporcionados.

No utilices conocimiento externo sobre quiniela.
No afirmes que un número tiene mayor probabilidad estadística de salir.
No uses expresiones como "seguro", "va a salir", "probable", "garantizado",
"número ganador" o equivalentes.

Tu tarea es únicamente RANKEAR las terminaciones según la CONFLUENCIA de señales
del método propio proporcionado por el backend.

Si existen más de 3 candidatos, elegí los 3 con mayor confluencia y respaldo
dentro de los datos.

Si dos candidatos tienen una valoración similar, priorizá:
1. mayor cantidad de tipos de señales coincidentes;
2. luego mayor respaldo de Compañeros del Sueño;
3. luego mayor presencia entre las señales recientes.

IMPORTANTE:
El resultado es una SUGERENCIA DE ANÁLISIS basada en el método propio de
Señales Pro. No representa una predicción ni una probabilidad matemática de
aparición.

RESPONDÉ ÚNICAMENTE con este formato exacto:

NUMEROS: XX,YY,ZZ

Donde XX, YY y ZZ son terminaciones de dos dígitos, siempre entre 00 y 99.
No agregues explicación, texto, porcentajes ni símbolos adicionales.`;

async function obtenerHistorialReciente() {
  const resp = await fetch(FIREBASE_URL + '/historialPermanente.json');
  if (!resp.ok) return {};
  const datos = await resp.json();
  return datos || {};
}

function ultimosNDias(historial, n) {
  const claves = Object.keys(historial).sort().reverse().slice(0, n);
  const numeros = [];
  claves.forEach(function (dia) {
    Object.values(historial[dia] || {}).forEach(function (reg) {
      if (reg && reg.term) numeros.push(reg.term);
    });
  });
  return numeros;
}

// Cruza las señales recientes contra la base de Compañeros del Sueño,
// consultando el motor (senales-pro-engine) que ya tiene esa lógica —
// así no duplicamos la base secreta acá en el scraper.
async function obtenerCruceCompanieros(numeros) {
  if (!MOTOR_URL) return [];
  try {
    const resp = await fetch(MOTOR_URL + '/api/motor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ todos: numeros, activos: numeros, extra: [] }),
    });
    if (!resp.ok) return [];
    const datos = await resp.json();
    return (datos.coincidencias && datos.coincidencias.tabla) || [];
  } catch (err) {
    console.error('Error consultando al motor para la Sugerencia de IA:', err.message);
    return [];
  }
}

async function calcularSugerenciaIA() {
  const historial = await obtenerHistorialReciente();
  const numeros = ultimosNDias(historial, 14);

  if (numeros.length < 5) {
    // No hay suficiente data guardada todavía
    return { numeros: [], texto: 'Todavía no hay suficiente historial guardado.' };
  }

  // Repetición 3+ durante la semana (últimos 7 días)
  const numerosSemana = ultimosNDias(historial, 7);
  const conteoSemana = {};
  numerosSemana.forEach(function (n) { conteoSemana[n] = (conteoSemana[n] || 0) + 1; });
  const repetidos3mas = Object.keys(conteoSemana).filter(function (n) { return conteoSemana[n] >= 3; });

  // Cruce real con Compañeros del Sueño (vía el motor)
  const tablaCruce = await obtenerCruceCompanieros(numeros);

  if (tablaCruce.length === 0) {
    return { numeros: [], texto: 'Todavía no hay suficiente cruce de datos para sugerir.' };
  }

  // TODO: sumar acá los datos de "Pendientes" cuando Dardo confirme
  // de dónde salen (endpoint del motor / nodo de Firebase / otro).
  const candidatos = tablaCruce.slice(0, 15).map(function (c) {
    return {
      numero: c.num,
      vecesComoCompanero: c.veces,
      respaldoTotal: c.suma,
      origenSeñales: c.origen,
      esFavorito: c.esFav,
      repetido3MasEnLaSemana: repetidos3mas.indexOf(c.num) >= 0,
    };
  });

  const prompt = PROMPT_BASE + '\n\nDATOS:\n' + JSON.stringify(candidatos);

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }],
  });

  const texto = msg.content
    .filter(function (b) { return b.type === 'text'; })
    .map(function (b) { return b.text; })
    .join('');

  const match = texto.match(/NUMEROS:\s*(\d{1,2}),\s*(\d{1,2}),\s*(\d{1,2})/i);
  if (!match) return { numeros: [], texto: 'No se pudo interpretar la respuesta de la IA.' };

  const numerosFinal = [match[1], match[2], match[3]].map(function (n) {
    return String(n).padStart(2, '0');
  });

  return { numeros: numerosFinal, texto: 'Sugerencia según cruce de señales y método propio.' };
}

app.get('/sugerencia-ia', async (req, res) => {
  try {
    const ahora = Date.now();
    if (ahora - cacheSugerencia.calculadoEn < DOS_HORAS && cacheSugerencia.numeros.length > 0) {
      return res.json(cacheSugerencia);
    }
    const resultado = await calcularSugerenciaIA();
    cacheSugerencia = Object.assign({}, resultado, { calculadoEn: ahora });
    res.json(cacheSugerencia);
  } catch (e) {
    console.error('Error en /sugerencia-ia:', e);
    res.status(500).json({ numeros: [], texto: 'Error al calcular la sugerencia.' });
  }
});

app.listen(PORT, () => console.log('Puerto ' + PORT));
