// /api/seloger.js – Vercel Serverless (CommonJS)
const cheerio = require('cheerio');
const removeAccents = require('remove-accents');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

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

async function getJSON(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA, 'accept': 'application/json,text/plain,*/*' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ---------- IMPORTANT : toutes les récup pages HTML passent ici ----------
async function getText(url) {
  const key = process.env.SCRAPFLY_KEY;

  // Pas de clé -> tentative en direct (souvent 403)
  if (!key) {
    const r = await fetch(url, {
      headers: {
        'user-agent': UA,
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'fr-FR,fr;q=0.9,en;q=0.8',
        'cache-control': 'no-cache'
      }
    });
    return { ok: r.ok, status: r.status, ct: r.headers.get('content-type') || '', text: r.ok ? await r.text() : '' };
  }

  // Passage via Scrapfly (anti-bot/proxy). Si besoin, ajouter &render_js=true (plus lent & plus cher).
  const api = `https://api.scrapfly.io/scrape?key=${key}` +
              `&url=${encodeURIComponent(url)}` +
              `&country=fr&asp=true&retry=2&timeout=30000`;

  const r = await fetch(api, { headers: { 'user-agent': UA } });
  if (!r.ok) {
    return { ok: false, status: r.status, ct: r.headers.get('content-type') || '', text: '' };
  }
  const data = await r.json();
  const html = data?.result?.content || data?.content || '';
  return { ok: !!html, status: html ? 200 : 500, ct: 'text/html', text: html };
}

// ------------------------------------------------------------------------

module.exports = async (req, res) => {
  try {
    const { name, insee, debug } = req.query;
    if (!name || !insee) {
      res.status(400).json({ error: 'missing params: name,insee' });
      return;
    }

    // 1) Région / département / CP via geo.api.gouv.fr
    let regionNom = null, deptNom = null, deptCode = null, cp = null;
    try {
      const commune = await getJSON(
        `https://geo.api.gouv.fr/communes/${encodeURIComponent(insee)}?fields=nom,codesPostaux,departement&format=json`
      );
      cp       = Array.isArray(commune?.codesPostaux) && commune.codesPostaux.length ? commune.codesPostaux[0] : null;
      deptNom  = commune?.departement?.nom  || null;
      deptCode = commune?.departement?.code || null;
      if (deptCode) {
        const dep = await getJSON(`https://geo.api.gouv.fr/departements/${deptCode}?fields=nom,codeRegion`);
        if (dep?.codeRegion) {
          const reg = await getJSON(`https://geo.api.gouv.fr/regions/${dep.codeRegion}?fields=nom`);
          regionNom = reg?.nom || null;
        }
      }
    } catch (_) {}

    const citySlug   = slug(name);
    const deptSlug   = deptNom ? slug(deptNom) : null;
    const regionSlug = regionNom ? slug(regionNom) : null;
    const cpSlug     = cp ? String(cp) : '';

    // 2) URLs candidates (du plus précis au plus simple)
    const candidates = [];
    if (regionSlug && deptSlug && cpSlug)
      candidates.push(`https://www.seloger.com/prix-de-l-immo/vente/${regionSlug}/${deptSlug}/${citySlug}-${cpSlug}/`);
    if (regionSlug && deptSlug)
      candidates.push(`https://www.seloger.com/prix-de-l-immo/vente/${regionSlug}/${deptSlug}/${citySlug}/`);
    if (deptSlug && cpSlug)
      candidates.push(`https://www.seloger.com/prix-de-l-immo/vente/${deptSlug}/${citySlug}-${cpSlug}/`);
    if (cpSlug)
      candidates.push(`https://www.seloger.com/prix-de-l-immo/vente/${citySlug}-${cpSlug}/`);
    candidates.push(`https://www.seloger.com/prix-de-l-immo/vente/${citySlug}.htm`);

    // 3) Essai des URLs + fallback moteur
    const tried = [];
    let html = null, finalUrl = null;

    for (const url of candidates) {
      const { ok, status, ct, text } = await getText(url);
      tried.push({ url, status, ct, len: text.length });
      if (ok && ct.includes('text/html') && text.length > 1500) { html = text; finalUrl = url; break; }
    }

    if (!html) {
      const q = `site:seloger.com "prix de l'immo" vente ${name}`;
      const { text: ddgHtml } = await getText(`https://duckduckgo.com/html/?q=${encodeURIComponent(q)}`);
      const m = ddgHtml.match(/https?:\/\/www\.seloger\.com\/prix-de-l-immo\/vente\/[^\s"']+/i);
      if (m && m[0]) {
        const { ok, status, ct, text } = await getText(m[0]);
        tried.push({ url: m[0], status, ct, len: text.length, from: 'ddg' });
        if (ok && ct.includes('text/html') && text.length > 1500) { html = text; finalUrl = m[0]; }
      }
    }

    if (!html) {
      if (debug) { res.status(200).json({ note: 'not-found', tried }); return; }
      res.status(200).json({ appart: null, maison: null, source_url: null, note: 'not-found' });
      return;
    }

    // 4) Parsing
    const $ = cheerio.load(html);
    const body = $('body').text().replace(/\s+/g, ' ');

    const appPatterns = [
      /(appartement|appartements)[^0-9]{0,40}([0-9\u202F\u00A0\s.,]{3,})\s*€\s*\/\s*(?:m²|m2)/i,
      /(prix|moyen|m²)[^\.]{0,120}(appartement|appartements)[^0-9]{0,40}([0-9\u202F\u00A0\s.,]{3,})/i,
    ];
    const maiPatterns = [
      /(maison|maisons)[^0-9]{0,40}([0-9\u202F\u00A0\s.,]{3,})\s*€\s*\/\s*(?:m²|m2)/i,
      /(prix|moyen|m²)[^\.]{0,120}(maison|maisons)[^0-9]{0,40}([0-9\u202F\u00A0\s.,]{3,})/i,
    ];

    let appart = null, maison = null;
    for (const re of appPatterns) { const m = body.match(re); if (m) { appart = toNum(m[2] || m[3]); if (appart) break; } }
    for (const re of maiPatterns) { const m = body.match(re); if (m) { maison = toNum(m[2] || m[3]); if (maison) break; } }

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

    if (debug) {
      res.status(200).json({ note: (appart || maison) ? 'ok' : 'parsed-but-empty', source_url: finalUrl, appart, maison, tried });
      return;
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
