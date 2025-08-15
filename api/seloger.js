// /api/seloger.js – Vercel Serverless Function (CommonJS)
const cheerio = require('cheerio');
const removeAccents = require('remove-accents');

module.exports = async (req, res) => {
  try {
    const { name, insee, dept } = req.query;
    if (!name || !insee) {
      res.status(400).json({ error: 'missing params: name,insee' });
      return;
    }

    // --- helpers ---
    const norm = (s) =>
      removeAccents(String(s).toLowerCase())
        .replace(/['’]/g, '-')               // d' Evian -> d-evian (on simplifie)
        .replace(/[^a-z0-9\s-]/g, ' ')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');

    const city = norm(name);
    const dd = String(dept || (insee || '').slice(0, 2)).padStart(2, '0');

    // convertit "4 123,5 €" / "4 123.5" -> 4124
    const toNum = (s) => {
      if (!s) return null;
      const cleaned = String(s)
        .replace(/\u202F|\u00A0/g, ' ')   // espaces fines / insécables
        .replace(/\s/g, '')
        .replace(/[^0-9.,]/g, '')
        .replace(',', '.');
      const m = cleaned.match(/[0-9]+(\.[0-9]+)?/);
      if (!m) return null;
      const v = parseFloat(m[0]);
      return Number.isFinite(v) ? Math.round(v) : null;
    };

    // --- 1) Trouver une URL plausible SeLoger ---
    const candidates = [
      `https://www.seloger.com/prix-de-l-immo/vente/${city}.htm`,
      `https://www.seloger.com/prix-de-l-immo/vente/${city}-${dd}/${city}.htm`,
      `https://www.seloger.com/prix-de-l-immo/vente/${city}-${dd}.htm`,
      `https://www.seloger.com/prix-de-l-immo/vente/${city}/${city}.htm`,
      `https://www.seloger.com/prix-de-l-immo/vente/${city}-${dd}/${city}-${dd}.htm`
    ];

    let html = null;
    let finalUrl = null;

    // essaie direct sur SeLoger
    for (const url of candidates) {
      try {
        const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
        const ct = r.headers.get('content-type') || '';
        if (r.ok && ct.includes('text/html')) {
          const t = await r.text();
          if (t && t.length > 1500) {
            html = t;
            finalUrl = url;
            break;
          }
        }
      } catch (_) {}
    }

    // fallback : chercher via DuckDuckGo (premier résultat SeLoger prix de l'immo/vente)
    if (!html) {
      try {
        const ddg = `https://duckduckgo.com/html/?q=${encodeURIComponent(
          `site:seloger.com "prix de l'immo" vente ${name} ${dd}`
        )}`;
        const rr = await fetch(ddg, { headers: { 'user-agent': 'Mozilla/5.0' } });
        const ht = await rr.text();
        const $s = cheerio.load(ht);
        let found = null;
        $s('a.result__a').each((_, a) => {
          const href = $s(a).attr('href') || '';
          if (href.includes('seloger.com/prix-de-l-immo/vente/')) {
            found = href;
            return false;
          }
        });
        if (found) {
          const r = await fetch(found, { headers: { 'user-agent': 'Mozilla/5.0' } });
          if (r.ok && (r.headers.get('content-type') || '').includes('text/html')) {
            html = await r.text();
            finalUrl = found;
          }
        }
      } catch (_) {}
    }

    if (!html) {
      res.status(200).json({ appart: null, maison: null, source_url: null, note: 'not-found' });
      return;
    }

    // --- 2) Parsing robuste ---
    const $ = cheerio.load(html);
    const bodyText = $('body').text().replace(/\s+/g, ' ');

    let appart = null, maison = null;

    // A) Heuristiques principales : nombre après mots-clefs + €/m² ou m2
    const appREs = [
      /(appartement|appartements)[^0-9]{0,30}([0-9\u202F\u00A0\s.,]{3,})\s*€\s*\/\s*(?:m²|m2)/i,
      /(prix|moyen|m²)[^\.]{0,80}(appartement|appartements)[^0-9]{0,20}([0-9\u202F\u00A0\s.,]{3,})/i
    ];
    const maiREs = [
      /(maison|maisons)[^0-9]{0,30}([0-9\u202F\u00A0\s.,]{3,})\s*€\s*\/\s*(?:m²|m2)/i,
      /(prix|moyen|m²)[^\.]{0,80}(maison|maisons)[^0-9]{0,20}([0-9\u202F\u00A0\s.,]{3,})/i
    ];

    for (const re of appREs) {
      const m = bodyText.match(re);
      if (m) { appart = toNum(m[2] || m[3]); if (appart) break; }
    }
    for (const re of maiREs) {
      const m = bodyText.match(re);
      if (m) { maison = toNum(m[2] || m[3]); if (maison) break; }
    }

    // B) petit fallback : chercher balises contenant "Appartements" / "Maisons"
    if (!appart || !maison) {
      $('*').each((_, el) => {
        const t = $(el).text().replace(/\s+/g, ' ');
        if (!appart && /appartement/i.test(t)) {
          const m = t.match(/([0-9\u202F\u00A0\s.,]{3,})\s*€\s*\/\s*(?:m²|m2)/i);
          if (m) appart = toNum(m[1]);
        }
        if (!maison && /maison/i.test(t)) {
          const m = t.match(/([0-9\u202F\u00A0\s.,]{3,})\s*€\s*\/\s*(?:m²|m2)/i);
          if (m) maison = toNum(m[1]);
        }
        if (appart && maison) return false;
      });
    }

    res.status(200).json({
      appart: appart ?? null,
      maison: maison ?? null,
      source_url: finalUrl,
      note: (appart || maison) ? 'ok' : 'parsed-but-empty'
    });
  } catch (e) {
    res.status(200).json({ appart: null, maison: null, error: String(e).slice(0,200) });
  }
};
