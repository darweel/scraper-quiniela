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
    const res = await fetch('https://www.notitimba.com/lots/', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const html = await res.text();
    const $ = cheerio.load(html);
    
    const provincias = ['La Ciudad', 'La Provincia', 'Santa Fe', 'Córdoba', 'Entre Ríos'];
    const sorteos = ['La Previa', 'Primera', 'Matutina', 'Vespertina', 'Nocturna'];
    const resultado = {};
    
    const tablas = $('table');
    tablas.each(function(i) {
      if(i >= sorteos.length) return;
      const sorteo = sorteos[i];
      resultado[sorteo] = {};
      $(this).find('tr').each(function() {
        const cols = $(this).find('td');
        if(cols.length >= 2) {
          const prov = $(cols[0]).text().trim();
          const num = $(cols[1]).text().trim();
          if(provincias.some(p => prov.includes(p.split(' ')[1] || p)) && num.match(/^\d{4}$/)) {
            resultado[sorteo][prov] = num;
          }
        }
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

app.listen(PORT, () => console.log('Scraper corriendo en puerto ' + PORT));
