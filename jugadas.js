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
  rnd = rnd || Math.random;
  log = log || console;
  let corriendo = false;
  let ultimoError = null;

  // Push SOLO a los celulares que se suscribieron como admin (esAdmin: true).
  // Usa la misma librería web-push que ya configuró index.js (claves VAPID).
  async function pushAdminReal(titulo, cuerpo) {
    let webpush;
    try { webpush = require('web-push'); } catch (e) { return; }
    const snap = await db.ref('pushSubs').once('value');
    const todas = snap.val() || {};
    const payload = JSON.stringify({ title: titulo, body: cuerpo, url: '/' });
    for (const id of Object.keys(todas)) {
      const x = todas[id];
      if (!x || !x.sub || x.sub.esAdmin !== true || !x.sub.endpoint) continue;
      const sub = { endpoint: x.sub.endpoint, keys: x.sub.keys, expirationTime: x.sub.expirationTime || null };
      try { await webpush.sendNotification(sub, payload); }
      catch (e) {
        if (e.statusCode === 410 || e.statusCode === 404) { try { await db.ref('pushSubs/' + id).remove(); } catch (e2) {} }
      }
    }
  }
  const enviarPushAdmin = pushAdmin || pushAdminReal;

  // ── Señales activas de los últimos 14 días, INCLUIDO HOY (servidor + celulares) ──
  async function activosVentana(jor) {
    const desde = sumarDias(jor, -(DIAS_VENTANA - 1));
    const vistos = {}; // jornada|sorteo|prov -> term (sin duplicados)
    const srv = (await db.ref('historialServidor').orderByKey().startAt(desde).once('value')).val() || {};
    Object.keys(srv).forEach((dia) => {
      if (dia > jor) return;
      Object.values(srv[dia] || {}).forEach((r) => {
        if (r && r.term && PROVS.indexOf(r.prov) >= 0) vistos[`${dia}|${r.sorteo}|${r.prov}`] = f2(r.term);
      });
    });
    // Historial que vienen guardando los celulares
    const cel = (await db.ref('historialPermanente').orderByKey().startAt(sumarDias(desde, -1)).once('value')).val() || {};
    Object.values(cel).forEach((dia) => {
      Object.values(dia || {}).forEach((r) => {
        if (!r || !r.term || !r.hora || !r.sorteo) return;
        if (r.prov && PROVS.indexOf(r.prov) < 0) return;
        const t = Date.parse(r.hora);
        if (isNaN(t)) return;
        const j = jornadaAR(t);
        if (j < desde || j > jor) return;
        const hs = horaSorteoTs(r.sorteo, j);
        if (hs && t < hs - 15 * MIN) return; // número viejo que la pizarra seguía mostrando
        const k = `${j}|${r.sorteo}|${r.prov || ''}`;
        if (!vistos[k]) vistos[k] = f2(r.term);
      });
    });
    const cuenta = {};
    Object.values(vistos).forEach((t) => { cuenta[t] = (cuenta[t] || 0) + 1; });
    return Object.keys(cuenta).filter((k) => cuenta[k] >= TH);
  }

  // Top Caliente del momento: [{num, veces}] (sin compañeros). null si no se puede.
  async function calcularTop(jor) {
    const activos = await activosVentana(jor);
    if (activos.length < 2) {
      ultimoError = 'menos de 2 señales activas en 14 días';
      return null;
    }
    const r = await fetch(`${motorUrl}/api/motor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ todos: [], activos, extra: [] }),
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) throw new Error('motor HTTP ' + r.status);
    const data = await r.json();
    const tabla = (data && data.coincidencias && data.coincidencias.tabla) || [];
    const vistos = {};
    const top = [];
    tabla.forEach((t) => {
      if (top.length >= 7) return;
      const n = f2(t.num);
      if (vistos[n]) return;
      vistos[n] = 1;
      top.push({ num: n, veces: parseInt(t.veces, 10) || 0 });
    });
    if (top.length === 0) {
      ultimoError = 'el motor no devolvió calientes';
      return null;
    }
    return top;
  }

  // Marca aciertos contra las FOTOS (idempotente). Devuelve los aciertos NUEVOS de la jugada.
  function aplicarAciertos(jug, resultados) {
    jug.aciertos = jug.aciertos || {};
    jug.aciertos.cal = listaArr(jug.aciertos.cal);
    jug.aciertos.azar = listaArr(jug.aciertos.azar);
    const fotos = jug.fotos || {};
    const nuevosCal = [];
    let cambio = false;
    resultados.forEach((r) => {
      if (!r || PROVS.indexOf(r.prov) < 0) return;
      const foto = fotos[r.sorteo];
      if (!foto) return; // sin foto previa no hay acierto que demostrar
      const hs = horaSorteoTs(r.sorteo, jug.jornada);
      if (!hs || foto.ts >= hs) return;
      const term = f2(r.term);
      [['cal', listaArr(foto.nums)], ['azar', listaArr(foto.azar)]].forEach(([tipo, nums]) => {
        if (nums.indexOf(term) < 0) return;
        const arr = jug.aciertos[tipo];
        if (arr.some((a) => a.num === term && a.sorteo === r.sorteo && a.prov === r.prov)) return;
        const ac = { num: term, full: r.full, sorteo: r.sorteo, prov: r.prov, ts: r.ts, foto: foto.ts };
        arr.push(ac);
        cambio = true;
        if (tipo === 'cal') nuevosCal.push(ac);
      });
    });
    return { cambio, nuevosCal };
  }

  async function procesar(dataCabezas) {
    if (corriendo) return { ok: false, motivo: 'ya estaba corriendo' };
    corriendo = true;
    const resumen = { nuevos: 0, top: null, fotos: [], aciertosNuevos: 0 };
    try {
      const now = ahora();
      const jor = jornadaAR(now);
      resumen.jornada = jor;
      if (esDomingo(jor)) return Object.assign(resumen, { ok: true, motivo: 'domingo, sin sorteos' });

      // ── 1. Registrar cabezas reales nuevas ──
      const prevJor = jornadaAnteriorConSorteos(jor);
      const [hSnap, bSnap, pSnap] = await Promise.all([
        db.ref(`historialServidor/${jor}`).once('value'),
        db.ref(`servidorBase/${jor}`).once('value'),
        db.ref(`historialServidor/${prevJor}`).once('value'),
      ]);
      const hist = hSnap.val() || {};
      const base = bSnap.val() || {};
      const prev = pSnap.val() || {};
      const updHist = {};
      const updBase = {};
      Object.entries(dataCabezas || {}).forEach(([sorteo, provs]) => {
        Object.entries(provs || {}).forEach(([prov, full]) => {
          if (!full || !/^\d{4}$/.test(String(full))) return;
          const k = claveRes(sorteo, prov);
          if (hist[k]) return; // ya registrado
          const hs = horaSorteoTs(sorteo, jor);
          if (!hs) return;
          if (now < hs - 15 * MIN) {
            // Todavía no es hora: lo que muestra la pizarra es de la jornada anterior
            if (base[k] === undefined) updBase[k] = full;
            return;
          }
          if (base[k] === full || updBase[k] === full) return;          // número viejo
          if (prev[k] && prev[k].full === full) return;                // igual al de ayer: viejo
          updHist[k] = { term: String(full).slice(-2), full: String(full), sorteo, prov, ts: now };
        });
      });
      if (Object.keys(updBase).length) await db.ref(`servidorBase/${jor}`).update(updBase);
      if (Object.keys(updHist).length) await db.ref(`historialServidor/${jor}`).update(updHist);
      resumen.nuevos = Object.keys(updHist).length;
      Object.assign(hist, updHist);

      // ── 2. Jugada de la jornada (se crea vacía la primera vez) ──
      let jug = (await db.ref(`jugadas/${jor}`).once('value')).val();
      if (!jug || jug.version !== 3) {
        // Jornada nueva (o una armada con la versión anterior, que queda guardada aparte)
        const legado = jug ? { calientes: jug.calientes || null, aciertos: jug.aciertos || null, creado: jug.creado || null } : null;
        jug = { jornada: jor, version: 3, origen: 'servidor' };
        if (legado) jug.legado = legado;
      }
      jug.fotos = jug.fotos || {};
      jug.aciertos = jug.aciertos || { cal: [], azar: [] };
      let cambio = false;

      // ── 3. Top 7 Caliente en vivo ──
      const hayQueRecalcular = !jug.topTs || resumen.nuevos > 0 || now - jug.topTs >= REFRESCO_MAX * MIN;
      if (hayQueRecalcular && motorUrl) {
        try {
          const top = await calcularTop(jor);
          if (top) {
            jug.top = top;
            jug.topTs = now;
            jug.calientes = top.map((t) => ({ num: t.num, grupo: grupoDe(t.num) }));
            cambio = true;
          }
        } catch (e) { ultimoError = 'motor: ' + e.message; log.error('[jugadas] no se pudo calcular el Top:', e.message); }
      }
      jug.top = listaArr(jug.top);
      jug.calientes = listaArr(jug.calientes);
      resumen.top = jug.top.map((t) => t.num);

      // ── 4. Foto 30' antes de cada sorteo (+ aviso al admin) ──
      for (const s of HOR) {
        const hs = horaSorteoTs(s.n, jor);
        if (jug.fotos[s.n] || now < hs - MIN_FOTO * MIN || now >= hs) continue;
        if (!jug.top.length) continue; // sin Top no hay foto
        const grupo = grupoDeSorteo(s.n);
        const nums = jug.calientes.filter((x) => x.grupo === grupo).map((x) => x.num);
        jug.fotos[s.n] = {
          ts: now,
          grupo,
          nums,
          azar: azarDeGrupo(grupo, nums.length, rnd),
          top: jug.top.map((t) => ({ num: t.num, veces: t.veces })),
        };
        cambio = true;
        resumen.fotos.push(s.n);
        if (nums.length) {
          try { await enviarPushAdmin(`🎯 Jugá en ${s.n}`, `Jugada: ${nums.join(' · ')}`); }
          catch (e) { log.error('[jugadas] push aviso:', e.message); }
        }
      }

      // ── 5. Aciertos contra las fotos ──
      const { cambio: cambioAc, nuevosCal } = aplicarAciertos(jug, Object.values(hist));
      resumen.aciertosNuevos = nuevosCal.length;

      if (cambio || cambioAc) {
        jug.actualizado = now;
        await db.ref(`jugadas/${jor}`).set(jug);
      }
      for (const a of nuevosCal) {
        try { await enviarPushAdmin(`✅ Acertó la jugada: ${a.num}`, `Salió ${a.full} en ${a.sorteo} (${a.prov})`); }
        catch (e) { log.error('[jugadas] push acierto:', e.message); }
      }
      if (!jug.top.length && ultimoError) resumen.motivo = ultimoError;
      return Object.assign(resumen, { ok: true });
    } catch (e) {
      log.error('[jugadas] error:', e);
      return Object.assign(resumen, { ok: false, motivo: e.message });
    } finally {
      corriendo = false;
    }
  }

  return { procesar, _internos: { jornadaAR, horaSorteoTs, activosVentana } };
};
