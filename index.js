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
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const html = await response.text();
    const $ = cheerio.load(html);
    
    const resultado = {
      'La Previa': {}, 'Primera': {}, 'Matutina': {}, 'Vespertina': {}, 'Nocturna': {}
    };
    
    const sorteoMap = {
      'Previa': 'La Previa', 'Primera': 'Primera',
      'Matutina': 'Matutina', 'Vespertina': 'Vespertina', 'Nocturna': 'Nocturna'
    };
    
    const provMap = {
      'CIUDAD': 'Nacional', 'PROVINCIA': 'Provincia',
      'SANTA FE': 'Santa Fe', 'CORDOBA': 'Córdoba', 'ENTRE RIOS': 'Entre Ríos'
    };

    $('table tr').each(function() {
      const cells = $(this).find('td');
      if(cells.length < 2) return;
      const prov = $(cells[0]).text().trim().toUpperCase();
      if(!provMap[prov]) return;
      cells.each(function(i) {
        if(i === 0) return;
        const txt = $(this).text().trim();
        const header = $('table tr').first().find('td').eq(i).text().trim();
        Object.keys(sorteoMap).forEach(k => {
          if(header.includes(k) && txt.match(/^\d{4}$/)) {
            resultado[sorteoMap[k]][provMap[prov]] = txt;
          }
        });
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
