// ══════════════════════════════════════════════════════════════
// JUGADA DEL DÍA — EN EL SERVIDOR (Señales Pro)
//
// Corre en Render cada vez que hay un scrapeo (lo dispara cron-job.org
// cada 5 minutos con GET /tick, o cualquier celular con la app abierta).
// No depende de ningún celular.
//
//  1. Guarda cada cabeza REAL del día en /historialServidor/{jornada}
//     (descarta los números viejos que la pizarra sigue mostrando).
//  2. A las 10:00 arma la Jugada del día en /jugadas/{jornada}:
//     Top Caliente (14 días) cruzado con los favoritos:
//       · favoritos → Vespertina y Nocturna
//       · el resto  → La Previa, Primera y Matutina
//     + 7 números al azar con el mismo reparto (control).
//  3. Marca aciertos: solo cabeza, solo en el sorteo asignado,
//     solo en la jornada, solo sorteos posteriores a la publicación.
//  4. Manda notificación push 30 minutos antes de cada sorteo.
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
const SORTEOS_TEMPRANO = ['La Previa', 'Primera', 'Matutina'];
const TH = 3; // un número es "señal activa" con 3+ salidas en la ventana
const DIAS_VENTANA = 14;

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
const sorteosDeGrupo = (g) => (g === 'tarde' ? SORTEOS_TARDE : SORTEOS_TEMPRANO);

function azarControl(nTarde, nTemp, rnd) {
  const usados = {};
  const sacar = (pool) => {
    const c = pool.filter((n) => !usados[n]);
    const n = c[Math.floor(rnd() * c.length)];
    usados[n] = 1;
    return n;
  };
  const noFav = [];
  for (let i = 0; i < 100; i++) if (FAVS.indexOf(f2(i)) < 0) noFav.push(f2(i));
  const out = [];
  for (let a = 0; a < nTarde; a++) out.push({ num: sacar(FAVS), grupo: 'tarde' });
  for (let b = 0; b < nTemp; b++) out.push({ num: sacar(noFav), grupo: 'temprano' });
  return out;
}

const listaArr = (x) => (Array.isArray(x) ? x.filter(Boolean) : x && typeof x === 'object' ? Object.values(x) : []);

module.exports = function crearModuloJugadas({ db, fetch, enviarPush, motorUrl, ahora, rnd, log }) {
  ahora = ahora || (() => Date.now());
  rnd = rnd || Math.random;
  log = log || console;
  let corriendo = false;
  let ultimoError = null;

  // ── Señales activas de los últimos 14 días (servidor + celulares) ──
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
    // Historial que vienen guardando los celulares (sirve hasta que el servidor junte sus 14 días)
    const cel = (await db.ref('historialPermanente').orderByKey().startAt(sumarDias(desde, -1)).once('value')).val() || {};
    Object.values(cel).forEach((dia) => {
      Object.values(dia || {}).forEach((r) => {
        if (!r || !r.term || !r.hora || !r.sorteo) return;
        if (r.prov && PROVS.indexOf(r.prov) < 0) return;
        const t = Date.parse(r.hora);
        if (isNaN(t)) return;
        const j = jornadaAR(t);
        if (j < desde || j >= jor) return; // solo días cerrados
        const k = `${j}|${r.sorteo}|${r.prov || ''}`;
        if (!vistos[k]) vistos[k] = f2(r.term);
      });
    });
    const cuenta = {};
    Object.values(vistos).forEach((t) => { cuenta[t] = (cuenta[t] || 0) + 1; });
    return Object.keys(cuenta).filter((k) => cuenta[k] >= TH);
  }

  async function crearJugada(jor, now) {
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
    const calientes = [];
    tabla.forEach((t) => {
      if (calientes.length >= 7) return;
      const n = f2(t.num);
      if (vistos[n]) return;
      vistos[n] = 1;
      calientes.push({ num: n, grupo: grupoDe(n) });
    });
    if (calientes.length === 0) {
      ultimoError = 'el motor no devolvió calientes';
      return null;
    }
    const nT = calientes.filter((x) => x.grupo === 'tarde').length;
    const jug = {
      jornada: jor,
      creado: now,
      origen: 'servidor',
      calientes,
      azar: azarControl(nT, calientes.length - nT, rnd),
      aciertos: { cal: [], azar: [] },
      avisos: {},
    };
    await db.ref(`jugadas/${jor}`).set(jug);
    log.log(`[jugadas] jugada ${jor} creada:`, calientes.map((c) => c.num + (c.grupo === 'tarde' ? '(V/N)' : '')).join(' '));
    return jug;
  }

  // Marca aciertos (idempotente). Devuelve los aciertos NUEVOS de calientes.
  function aplicarAciertos(jug, resultados) {
    jug.aciertos = jug.aciertos || {};
    jug.aciertos.cal = listaArr(jug.aciertos.cal);
    jug.aciertos.azar = listaArr(jug.aciertos.azar);
    const nuevosCal = [];
    let cambio = false;
    resultados.forEach((r) => {
      if (PROVS.indexOf(r.prov) < 0) return;
      const hs = horaSorteoTs(r.sorteo, jug.jornada);
      if (!hs || hs < jug.creado) return; // el sorteo fue antes de publicar la jugada
      const term = f2(r.term);
      ['cal', 'azar'].forEach((tipo) => {
        const nums = listaArr(tipo === 'cal' ? jug.calientes : jug.azar);
        nums.forEach((x) => {
          if (x.num !== term || sorteosDeGrupo(x.grupo).indexOf(r.sorteo) < 0) return;
          const arr = jug.aciertos[tipo];
          if (arr.some((a) => a.num === term && a.sorteo === r.sorteo && a.prov === r.prov)) return;
          const ac = { num: term, full: r.full, sorteo: r.sorteo, prov: r.prov, ts: r.ts };
          arr.push(ac);
          cambio = true;
          if (tipo === 'cal') nuevosCal.push(ac);
        });
      });
    });
    return { cambio, nuevosCal };
  }

  async function procesar(dataCabezas) {
    if (corriendo) return { ok: false, motivo: 'ya estaba corriendo' };
    corriendo = true;
    const resumen = { nuevos: 0, jugada: null, aciertosNuevos: 0, avisos: [] };
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

      // ── 2. Jugada del día ──
      let jug = (await db.ref(`jugadas/${jor}`).once('value')).val();
      if (!jug && motorUrl) {
        try { jug = await crearJugada(jor, now); }
        catch (e) { ultimoError = 'motor: ' + e.message; log.error('[jugadas] no se pudo crear:', e.message); }
      }
      if (!jug) return Object.assign(resumen, { ok: true, motivo: ultimoError || 'sin jugada' });
      jug.calientes = listaArr(jug.calientes);
      jug.azar = listaArr(jug.azar);
      jug.avisos = jug.avisos || {};
      resumen.jugada = jug.calientes.map((c) => c.num);

      // ── 3. Aciertos ──
      const { cambio, nuevosCal } = aplicarAciertos(jug, Object.values(hist));
      resumen.aciertosNuevos = nuevosCal.length;

      // ── 4. Avisos 30 minutos antes ──
      let avisoCambio = false;
      const yaSalieron = {};
      jug.aciertos.cal.forEach((a) => { yaSalieron[a.num] = 1; });
      for (const s of HOR) {
        const diff = horaSorteoTs(s.n, jor) - now;
        if (diff <= 0 || diff > 30 * MIN || jug.avisos[s.n]) continue;
        jug.avisos[s.n] = true;
        avisoCambio = true;
        const grupo = SORTEOS_TARDE.indexOf(s.n) >= 0 ? 'tarde' : 'temprano';
        const nums = jug.calientes.filter((x) => x.grupo === grupo && !yaSalieron[x.num]).map((x) => x.num);
        if (!nums.length) continue;
        resumen.avisos.push(s.n);
        try { await enviarPush(`🎯 Jugá en ${s.n}`, `Jugada del día: ${nums.join(' · ')}`); }
        catch (e) { log.error('[jugadas] push aviso:', e.message); }
      }

      if (cambio || avisoCambio) {
        await db.ref(`jugadas/${jor}`).update({ aciertos: jug.aciertos, avisos: jug.avisos });
      }
      for (const a of nuevosCal) {
        try { await enviarPush(`✅ Acertó la jugada: ${a.num}`, `Salió ${a.full} en ${a.sorteo} (${a.prov})`); }
        catch (e) { log.error('[jugadas] push acierto:', e.message); }
      }
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
