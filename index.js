const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const admin = require('firebase-admin');

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

async function scrapeQuiniela() {
  try {
    const response = await fetch('https://www.tujugada.com.ar', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    const html = await response.text();
    const $ = cheerio.load(html);
    const text = $('body').text().replace(/\s+/g, ' ');

    const sorteos = {
      'La Previa': {}, 'Primera': {}, 'Matutina': {},
      'Vespertina': {}, 'Nocturna': {}
    };
    const provincias = ['Nacional', 'Provincia', 'Santa Fe', 'Córdoba', 'Entre Ríos'];
    const patron = /(\d{4})/g;
    
    let matches = [...text.matchAll(patron)];
    let idx = 0;
    for (const sorteo of Object.keys(sorteos)) {
      for (const prov of provincias) {
        if (matches[idx]) {
          sorteos[sorteo][prov] = matches[idx][0].slice(-2);
          idx++;
        }
      }
    }

    // Guardar en Firebase
    await db.ref('resultados').set({
      data: sorteos,
      timestamp: Date.now()
    });

    return sorteos;
  } catch (err) {
    console.error('Error scraping:', err);
    return null;
  }
}

app.get('/', async (req, res) => {
  const data = await scrapeQuiniela();
  if (data) {
    res.json({ ok: true, data });
  } else {
    res.status(500).json({ ok: false, error: 'Error al scrapear' });
  }
});

app.listen(PORT, () => console.log('Puerto ' + PORT));
