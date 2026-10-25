// ══════════════════════════════════════════════════════════════
// JUGADA DEL DÍA — EN EL SERVIDOR (Señales Pro) · v3 "Top en vivo + fotos"
//
// Corre en Render en cada scrapeo (cron-job.org cada 5 minutos con
// GET /tick, o cualquier celular con la app abierta). No depende de
// ningún celular.
//
//  1. Guarda cada cabeza REAL del día en /historialServidor/{jornada}
//     (descarta los números viejos que la pizarra sigue mostrando).
//  2. TOP 7 CALIENTE EN VIVO: se recalcula con cada resultado nuevo
//     (ventana de 14 días, incluido hoy) y se guarda en /jugadas/{jornada}.top
//     — solo número y veces, NUNCA los compañeros.
//  3. La jugada sigue al Top en vivo:
//       · favoritos → Vespertina y Nocturna
//       · el resto  → La Previa, Primera y Matutina
//  4. FOTO ANTES DE CADA SORTEO: 30 minutos antes, se congela la jugada
//     de ese sorteo con su hora en /jugadas/{jornada}/fotos/{sorteo}
//     (+ 7 números al azar con el mismo reparto, como control).
//  5. ACIERTO = la cabeza de ese sorteo estaba en la FOTO de ese sorteo.
//  6. Push 30' antes (con los números de la foto) y al acertar: SOLO admin.
//
// La jornada va de 10:00 a 10:00 del día siguiente (hora Argentina).
// ══════════════════════════════════════════════════════════════

const AR_MS = 3 * 60 * 60 * 1000; // Argentina = UTC-3 todo el año
const MIN = 60 * 1000;
const HOR = [
  { n: 'La Previa', h: 10, m: 30 },
  { n: 'Primera', h: 12, m: 0 },
  { n: 'Matutina', h: 15, m: 0 },
  { n: 'Vespertina', h: 18, m: 0 },
  { n: 'Nocturna', h: 21, m: 0 },
];
const FAVS = ['00', '02', '27', '32', '35', '45', '55', '56', '58', '82', '85', '96', '97'];
const PROVS = ['Nacional', 'Provincia', 'Santa Fe', 'Córdoba', 'Entre Ríos', 'Uruguay'];
const SORTEOS_TARDE = ['Vespertina', 'Nocturna'];
const TH = 3;               // un número es "señal activa" con 3+ salidas en la ventana
const DIAS_VENTANA = 14;
const MIN_FOTO = 30;        // la foto se saca en los 30 minutos previos al sorteo
const REFRESCO_MAX = 60;    // aunque no haya resultados nuevos, recalcula el Top cada 60'

const f2 = (n) => String(parseInt(n, 10) || 0).padStart(2, '0');
const isoUTC = (d) => d.toISOString().slice(0, 10);

function jornadaAR(ts) {
  const ar = new Date(ts - AR_MS); // reloj argentino leído con getters UTC
  if (ar.getUTCHours() < 10) ar.setUTCDate(ar.getUTCDate() - 1);
  return isoUTC(ar);
}
function sumarDias(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return isoUTC(d);
}
function esDomingo(iso) {
  return new Date(iso + 'T12:00:00Z').getUTCDay() === 0;
}
function horaSorteoTs(nombre, iso) {
  const s = HOR.find((x) => x.n === nombre);
  if (!s) return null;
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d, s.h, s.m) + AR_MS;
}
function jornadaAnteriorConSorteos(iso) {
  let p = sumarDias(iso, -1);
  if (esDomingo(p)) p = sumarDias(p, -1);
  return p;
}
const claveRes = (sorteo, prov) => `${sorteo}__${prov}`;
const grupoDe = (num) => (FAVS.indexOf(num) >= 0 ? 'tarde' : 'temprano');
const grupoDeSorteo = (sorteo) => (SORTEOS_TARDE.indexOf(sorteo) >= 0 ? 'tarde' : 'temprano');
const listaArr = (x) => (Array.isArray(x) ? x.filter((v) => v !== null && v !== undefined) : x && typeof x === 'object' ? Object.values(x) : []);

function azarDeGrupo(grupo, cantidad, rnd) {
  const pool = [];
  for (let i = 0; i < 100; i++) {
    const n = f2(i);
    if ((FAVS.indexOf(n) >= 0) === (grupo === 'tarde')) pool.push(n);
  }
  const out = [];
  while (out.length < cantidad && pool.length) {
    const k = Math.floor(rnd() * pool.length);
    out.push(pool.splice(k, 1)[0]);
  }
  return out;
}

module.exports = function crearModuloJugadas({ db, fetch, motorUrl, ahora, rnd, log, pushAdmin }) {
  ahora = ahora || (() => Date.now());
  rnd = r
