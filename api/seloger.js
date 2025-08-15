// /api/seloger.js – Vercel Serverless Function (CommonJS)
const cheerio = require('cheerio');
const removeAccents = require('remove-accents');

// utilitaire
const slug = (s) =>
  removeAccents(String(s).toLowerCase())
    .replace(/['’]/g, '-')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

const toNum = (s) => {
  if (!s) return null;
  const cleaned = String(s)
    .replace(/\u202F|\u00A0/g, ' ')
    .replace(/\s/g, '')
    .replace(/[^0-9.,]/g, '')
    .replace(',', '.');
  const m = cleaned.match(/[0-9]+(\.[0-9]+)?/);
  if (!m) return null;
  const v = parseFloat(m[0]);
  return Number.isFinite(v) ? Math.round(v) : null;
};

async function fetchText(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(String(r.status));
  return await r.text();
}

module.exports = async (req, res) => {
  try {
    const { name, insee } = req.query;
    if (!name || !insee) {
      res.status(400).json({ error: 'missing params: name,insee' });
      return;
    }

    // 1) On récupère région / département / codes postaux via geo.api.gouv.fr
    let regionNom = null, deptNom = null, cp = null;

    try {
      const j = await (await fetch(
        `https://geo.api.gouv.fr/communes/${encodeURIComponent(insee)}?fields=nom,codesPostaux,departement&format=json`
      )).json();

      cp = Array.isArray(j?.codesPostaux) && j.codesPostaux.length ? j.codesPostaux[0] : null; // on prend le 1er CP
      deptNom = j?.departement?.nom || null;

      // récupérer la région (via départements)
      if (j?.departement?.code) {
        const dep = await (await fetch(`https://geo.api.gouv.fr/departements/${j.departement.code}?fields=nom,codeRegion`)).json();
        if (dep?.codeRegion) {
          const reg = await (await fetch(`https://geo.api.gouv.fr/regions/${dep.codeRegion}?fields=nom`)).json();
          regionNom = reg?.nom || null;
        }
      }
    } catch (_) {}

    const citySlug = slug(name);
    const deptSlug = deptNom ? slug(deptNom) : null;
    const regionSlug = regionNom ? slug(regionNom) : null;
    const cpSlug = cp ? String(cp) : '';

    // 2) Génère un ensemble d’URLs candidates (du plus “riche” au plus simple)
    const candidates = [];
    if (regionSlug && deptSlug && cpSlug) {
      candidates.push(`https://www.seloger.com/prix-de-l-immo/vente/${regionSlug}/${deptSlug}/${citySlug}-${cpSlug}/`);
    }
    if (regionSlug && deptSlug) {
      candidates.push(`https://www.seloger.com/prix-de-l-immo/vente/${regionSlug}/${deptSlug}/${citySlug}/`);
    }
    if (deptSlug && cpSlug) {
      candidates.push(`https://www.seloger.com/prix-de-l-immo/vente/${deptSlug}/${citySlug}-${cpSlug}/`);
    }
    // formats plus simples
    candidates.push(`https://www.seloger.com/prix-de-l-immo/vente/${citySlug}.htm`);
    if (cpSlug) candidates.push(`https://www.seloger.com/prix-de-l-immo/vente/${citySlug}-${cpSlug}/`);

    // 3) Essaie les candidates
    let html = null;
    let finalUrl = null;
    for (const url of candidates) {
      try {
        const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
        const ct = r.headers.get('content-type') || '';
        if (r.ok && ct.includes('text/html')) {
          const t = await r.text();
          if (t && t.length > 1500) { html = t; finalUrl = url; break; }
        }
      } catch (_) {}
    }

    // 4) Fallback : moteur de recherche (DuckDuckGo) – on extrait un lien seloger prix/vente
    if (!html) {
      try {
        const q = `site:seloger.com "prix de l'immo" vente ${name}`;
        const ddg = `https://duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
        const h = await fetchText(ddg);

        // Regex large pour capter une URL seloger prix-de-l-immo/vente
        const m = h.match(/https?:\/\/www\.seloger\.com\/prix-de-l-immo\/vente\/[^\s"']+/i);
        if (m && m[0]) {
          const rr = await fetch(m[0], { headers: { 'user-agent': 'Mozilla/5.0' } });
          if (rr.ok && (rr.headers.get('content-type') || '').includes('text/html')) {
            html = await rr.text();
            finalUrl = m[0];
          }
        }
      } catch (_) {}
    }

    if (!html) {
      res.status(200).json({ appart: null, maison: null, source_url: null, note: 'not-found' });
      return;
    }

    // 5) Parsing robuste
    const $ = cheerio.load(html);
    const body = $('body').text().replace(/\s+/g, ' ');

    let appart = null, maison = null;

    const appPatterns = [
      /(appartement|appartements)[^0-9]{0,40}([0-9\u202F\u00A0\s.,]{3,})\s*€\s*\/\s*(?:m²|m2)/i,
      /(prix|moyen|m²)[^\.]{0,100}(appartement|appartements)[^0-9]{0,30}([0-9\u202F\u00A0\s.,]{3,})/i,
    ];
    const maiPatterns = [
      /(maison|maisons)[^0-9]{0,40}([0-9\u202F\u00A0\s.,]{3,})\s*€\s*\/\s*(?:m²|m2)/i,
      /(prix|moyen|m²)[^\.]{0,100}(maison|maisons)[^0-9]{0,30}([0-9\u202F\u00A0\s.,]{3,})/i,
    ];

    for (const re of appPatterns) { const m = body.match(re); if (m) { appart = toNum(m[2] || m[3]); if (appart) break; } }
    for (const re of maiPatterns) { const m = body.match(re); if (m) { maison = toNum(m[2] || m[3]); if (maison) break; } }

    // petit fallback DOM local
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
