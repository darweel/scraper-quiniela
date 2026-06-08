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
    const response = await fetch('https://www.notitimba.com/', {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html'
      }
    });
    const html = await response.text();
    const $ = cheerio.load(html);
    
    const sorteos = ['La Previa','Primera','Matutina','Vespertina','Nocturna'];
    const provMap = {'Ciudad':'Nacional','Provincia':'Provincia','Santa':'Santa Fe','rdoba':'Córdoba','R':'Entre Ríos'};
    const resultado = {};
    sorteos.forEach(s => resultado[s] = {});

    $('table').each(function(i) {
      if(i >= sorteos.length) return;
      const sorteo = sorteos[i];
      $(this).find('tr').each(function() {
        const cols = $(this).find('td');
        if(cols.length < 2) return;
        const prov = $(cols[0]).text().trim();
        const num = $(cols[1]).text().trim();
        if(!num.match(/^\d{4}$/)) return;
        Object.keys(provMap).forEach(k => {
          if(prov.includes(k)) resultado[sorteo][provMap[k]] = num;
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
