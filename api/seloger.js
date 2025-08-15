// /api/seloger.js – Vercel Serverless Function (CommonJS)
const cheerio = require('cheerio');
const removeAccents = require('remove-accents');

// NB: Node 18+ fournit "fetch" globalement, pas besoin d'importer.
module.exports = async (req, res) => {
  try {
    const { name, insee, dept } = req.query;
    if (!name || !insee) {
      res.status(400).json({ error: 'missing params: name,insee' });
      return;
    }

    // --- Normalisation du nom de ville en "slug"
    const norm = (s) => removeAccents(String(s).toLowerCase())
      .replace(/[^a-z0-9\s-]/g, ' ')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    const city = norm(name);
    const dd = String(dept || (insee || '').slice(0, 2)).padStart(2, '0');

    // --- Quelques URL candidates (SeLoger a plusieurs formats courants)
    const candidates = [
      `https://www.seloger.com/prix-de-l-immo/vente/${city}.htm`,
      `https://www.seloger.com/prix-de-l-immo/vente/${city}-${dd}/${city}.htm`,
      `https://www.seloger.com/prix-de-l-immo/vente/${city}-${dd}.htm`,
    ];

    let html = null;
    let finalUrl = null;

    for (const url of candidates) {
      try {
        const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
        if (r.ok && (r.headers.get('content-type') || '').includes('text/html')) {
          const t = await r.text();
          if (t && t.length > 1000) { // page réelle, pas une redirection vide
            html = t;
            finalUrl = url;
            break;
          }
        }
      } catch (_) {}
    }

    if (!html) {
      res.status(200).json({ appart: null, maison: null, source_url: null, note: 'not-found' });
      return;
    }

    // --- Parsing "best effort"
    const $ = cheerio.load(html);
    const text = $('body').text().replace(/\s+/g, ' ');

    const num = (s) => {
      if (!s) return null;
      const x = String(s).replace(/\s/g, '').replace(/[^0-9.,]/g, '').replace(',', '.');
      const m = x.match(/[0-9]+(\.[0-9]+)?/);
      if (!m) return null;
      const v = parseFloat(m[0]);
      return Number.isFinite(v) ? Math.round(v) : null;
    };

    let appart = null, maison = null;

    // Heuristiques : on capte les 1ers nombres après mots-clés
    let m = text.match(/(prix|moyen|m²)[^\.]{0,80}(appartement|appartements)[^0-9]{0,20}([0-9\s.,]{3,})/i);
    if (m) appart = num(m[3]);
    m = text.match(/(prix|moyen|m²)[^\.]{0,80}(maison|maisons)[^0-9]{0,20}([0-9\s.,]{3,})/i);
    if (m) maison = num(m[3]);

    if (!appart) {
      m = text.match(/appartement[^0-9]{0,20}([0-9\s.,]{3,})\s*€\s*\/\s*m²/i);
      if (m) appart = num(m[1]);
    }
    if (!maison) {
      m = text.match(/maison[^0-9]{0,20}([0-9\s.,]{3,})\s*€\s*\/\s*m²/i);
      if (m) maison = num(m[1]);
    }

    res.status(200).json({
      appart,
      maison,
      source_url: finalUrl,
      note: (appart || maison) ? 'ok' : 'parsed-but-empty'
    });
  } catch (e) {
    res.status(200).json({ appart: null, maison: null, error: String(e).slice(0, 200) });
  }
};
