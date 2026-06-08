const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

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
