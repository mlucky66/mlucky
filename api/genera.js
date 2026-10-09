// api/genera.js
// Generazione seduta allenamento via Gemini (JSON strutturato).
// Chiave solo in Environment Variables Vercel — mai nel client.
//
// Env:
//   GEMINI_API_KEY         (obbligatoria)
//   GEMINI_MODEL           (obbligatoria)
//   GEMINI_MODEL_FALLBACK  (facoltativa)
//   STAFF_CODE             (facoltativa) ?codice= o header x-staff-code

const STATI_TEMPORANEI = [429, 500, 502, 503, 504];
const TENTATIVI_PER_MODELLO = 2;
const PAUSA_MS = 1500;
const TIMEOUT_MS = 45000;

const PHASES = ['riscaldamento', 'analitica', 'atletica', 'situazionale', 'tattica', 'partitella'];

const attendi = (ms) => new Promise((r) => setTimeout(r, ms));

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    if (typeof req.body === 'string') {
      try { return resolve(JSON.parse(req.body || '{}')); } catch (e) { return reject(e); }
    }
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 2e6) { reject(new Error('body troppo grande')); req.destroy(); } });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function chiamaGemini(modello, chiave, corpo) {
  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(modello) +
    ':generateContent';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': chiave },
      body: JSON.stringify(corpo),
      signal: ctrl.signal
    });
    let dati = null;
    try { dati = await r.json(); } catch (e) { dati = null; }
    return { ok: r.ok, stato: r.status, dati: dati };
  } catch (e) {
    return {
      ok: false,
      stato: 0,
      dati: null,
      errore: e && e.name === 'AbortError' ? 'timeout' : String((e && e.message) || e)
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildPrompt(p) {
  const lines = [];
  lines.push('Sei un assistente per un allenatore di calcio giovanile oratoriale (Italia).');
  lines.push('Devi comporre una seduta di allenamento scegliendo SOLO esercizi dal catalogo fornito (usa i loro id esatti).');
  lines.push('Non inventare esercizi. Non usare nomi di persone. Rispondi solo con JSON conforme allo schema.');
  lines.push('');
  lines.push('Vincoli seduta:');
  lines.push('- Giorno: ' + (p.dayId || '?'));
  lines.push('- Durata totale: ' + p.duration + " minuti");
  lines.push('- Numero slot esercizi (esclusa partitella): ' + p.nSlots);
  lines.push('- Ordine fasi degli slot (uno per esercizio): ' + (p.slotPhases || []).join(' → '));
  lines.push('- La partitella NON è nel catalogo da scegliere: è il tempo residuo a fine seduta.');
  if (p.objectiveText) lines.push('- Obiettivo testuale: ' + String(p.objectiveText).slice(0, 400));
  if (p.objectiveTags && p.objectiveTags.length) lines.push('- Tag obiettivo: ' + p.objectiveTags.join(', '));
  lines.push('');
  lines.push('Storico recente (id esercizi già usati, da non ripetere se possibile):');
  const recent = Array.isArray(p.recent) ? p.recent : [];
  if (!recent.length) lines.push('(nessuno)');
  recent.slice(0, 8).forEach((s, i) => {
    lines.push((i + 1) + '. ' + (Array.isArray(s.exerciseIds) ? s.exerciseIds.join(', ') : ''));
  });
  lines.push('');
  lines.push('Catalogo esercizi (id, fasi, durata min-max, tag):');
  (p.catalog || []).forEach((ex) => {
    lines.push(
      '- id="' + ex.id + '" fasi=[' + (ex.phases || []).join(',') + '] dur=' +
      ex.durationMin + '-' + ex.durationMax + ' tag=[' + (ex.tags || []).join(',') + ']'
    );
  });
  lines.push('');
  lines.push('Restituisci esattamente ' + p.nSlots + ' elementi in "slots", nello stesso ordine delle fasi richieste.');
  lines.push('Per ogni slot: id (del catalogo), duration (intero tra min e max di quell\'esercizio), phase (fase dello slot), reason (breve, italiano).');
  lines.push('La somma delle duration degli slot dovrebbe lasciare circa 10–25 minuti di residuo per la partitella rispetto a ' + p.duration + "'.'");
  return lines.join('\n');
}

function validateSlots(slots, payload) {
  const catalog = {};
  (payload.catalog || []).forEach((ex) => { if (ex && ex.id) catalog[ex.id] = ex; });
  const nSlots = payload.nSlots || 0;
  const phases = payload.slotPhases || [];
  const warnings = [];
  if (!Array.isArray(slots) || slots.length !== nSlots) {
    return { ok: false, errore: 'Numero slot non valido (attesi ' + nSlots + ')', warnings: warnings };
  }
  const seen = {};
  const out = [];
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i] || {};
    const id = String(s.id || s.exerciseId || '').trim();
    const ex = catalog[id];
    if (!ex) return { ok: false, errore: 'Id non in catalogo: ' + id, warnings: warnings };
    if (seen[id]) return { ok: false, errore: 'Esercizio ripetuto: ' + id, warnings: warnings };
    seen[id] = true;
    let dur = parseInt(s.duration, 10);
    if (!Number.isFinite(dur)) dur = ex.durationMin;
    if (dur < ex.durationMin) dur = ex.durationMin;
    if (dur > ex.durationMax) dur = ex.durationMax;
    const phase = phases[i] || s.phase || (ex.phases && ex.phases[0]) || '';
    if (ex.phases && ex.phases.length && phase && ex.phases.indexOf(phase) < 0) {
      warnings.push('«' + id + '» non ha fase ' + phase + ' (accettato comunque)');
    }
    out.push({
      phase: phase,
      exerciseId: id,
      duration: dur,
      reason: String(s.reason || '').slice(0, 240)
    });
  }
  const sum = out.reduce((a, b) => a + b.duration, 0);
  const part = Math.max(0, (payload.duration || 90) - sum);
  if (part < 5) warnings.push('Residuo partitella molto basso (' + part + '′)');
  return {
    ok: true,
    draft: {
      ok: true,
      dayId: payload.dayId,
      duration: payload.duration,
      nSlots: nSlots,
      slots: out,
      partitellaMinutes: part,
      partitella: { duration: part, exerciseId: null, phase: 'partitella', reason: 'Tempo residuo a fine seduta' },
      objectiveTags: payload.objectiveTags || [],
      warnings: warnings,
      source: 'ai'
    }
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-staff-code');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, errore: 'Usa POST con body JSON.' });
  }

  const chiave = process.env.GEMINI_API_KEY;
  const principale = process.env.GEMINI_MODEL;
  const riserva = process.env.GEMINI_MODEL_FALLBACK;
  if (!chiave || !principale) {
    return res.status(500).json({
      ok: false,
      errore: 'Mancano GEMINI_API_KEY o GEMINI_MODEL nelle Environment Variables di Vercel.'
    });
  }

  const richiesto = process.env.STAFF_CODE;
  if (richiesto) {
    const dato = (req.query && req.query.codice) || req.headers['x-staff-code'];
    if (dato !== richiesto) {
      return res.status(401).json({ ok: false, errore: 'Codice non valido.' });
    }
  }

  let payload;
  try {
    payload = await readBody(req);
  } catch (e) {
    return res.status(400).json({ ok: false, errore: 'Body JSON non valido.' });
  }

  if (!payload || !Array.isArray(payload.catalog) || !payload.catalog.length) {
    return res.status(400).json({ ok: false, errore: 'Catalogo esercizi mancante o vuoto.' });
  }
  if (!payload.nSlots || !Array.isArray(payload.slotPhases) || payload.slotPhases.length !== payload.nSlots) {
    return res.status(400).json({ ok: false, errore: 'slotPhases / nSlots non coerenti.' });
  }

  // sanitizza catalogo (solo campi anonimi)
  payload.catalog = payload.catalog.slice(0, 200).map((ex) => ({
    id: String(ex.id || '').slice(0, 80),
    phases: Array.isArray(ex.phases) ? ex.phases.filter((p) => PHASES.indexOf(p) >= 0).slice(0, 6) : [],
    durationMin: Math.max(1, Math.min(120, parseInt(ex.durationMin, 10) || 15)),
    durationMax: Math.max(1, Math.min(120, parseInt(ex.durationMax, 10) || 15)),
    tags: Array.isArray(ex.tags) ? ex.tags.map((t) => String(t).slice(0, 24)).slice(0, 8) : []
  })).filter((ex) => ex.id);

  const schema = {
    type: 'OBJECT',
    properties: {
      slots: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            id: { type: 'STRING' },
            duration: { type: 'INTEGER' },
            phase: { type: 'STRING' },
            reason: { type: 'STRING' }
          },
          required: ['id', 'duration']
        }
      }
    },
    required: ['slots']
  };

  const corpoBase = {
    contents: [{ role: 'user', parts: [{ text: buildPrompt(payload) }] }],
    generationConfig: {
      maxOutputTokens: 4096,
      temperature: 0.4,
      responseMimeType: 'application/json',
      responseSchema: schema
    }
  };

  const modelli = [principale];
  if (riserva && riserva !== principale) modelli.push(riserva);

  async function provaGenerazione(extraHint) {
    const corpo = JSON.parse(JSON.stringify(corpoBase));
    if (extraHint) {
      corpo.contents[0].parts[0].text += '\n\nCORREZIONE: ' + extraHint;
    }
    const registro = [];
    let ultimo = null;
    for (const modello of modelli) {
      for (let tentativo = 1; tentativo <= TENTATIVI_PER_MODELLO; tentativo++) {
        const esito = await chiamaGemini(modello, chiave, corpo);
        registro.push({ modello: modello, tentativo: tentativo, stato: esito.stato });
        if (esito.ok) {
          const dati = esito.dati || {};
          const parti =
            dati.candidates &&
            dati.candidates[0] &&
            dati.candidates[0].content &&
            dati.candidates[0].content.parts;
          const testo = parti && parti[0] && parti[0].text ? parti[0].text : '';
          let parsed;
          try { parsed = JSON.parse(testo); } catch (e) {
            return { ok: false, registro: registro, errore: 'JSON non valido dal modello', grezzo: testo };
          }
          const v = validateSlots(parsed.slots || parsed, payload);
          if (!v.ok) {
            return { ok: false, registro: registro, errore: v.errore, modello: modello };
          }
          v.draft.modello = modello;
          v.draft.usatoModelloDiRiserva = modello !== principale;
          v.draft.tentativi = registro;
          return { ok: true, draft: v.draft, registro: registro };
        }
        ultimo = esito;
        if (esito.stato === 400 || esito.stato === 401 || esito.stato === 403) {
          return {
            ok: false,
            registro: registro,
            errore: 'Gemini ha rifiutato la richiesta (chiave, permessi o formato).',
            dettaglio: esito.dati && esito.dati.error ? esito.dati.error.message : esito.dati
          };
        }
        if (STATI_TEMPORANEI.indexOf(esito.stato) !== -1 || esito.stato === 0) {
          if (tentativo < TENTATIVI_PER_MODELLO) await attendi(PAUSA_MS);
          continue;
        }
        break;
      }
    }
    return {
      ok: false,
      registro: registro,
      errore: 'Gemini non disponibile in questo momento.',
      dettaglio: ultimo && ultimo.dati && ultimo.dati.error
        ? ultimo.dati.error.message
        : ultimo && ultimo.errore
        ? ultimo.errore
        : null
    };
  }

  let result = await provaGenerazione(null);
  if (!result.ok && result.errore && /catalogo|ripetut|slot|Id non/i.test(result.errore)) {
    // un solo retry con hint di validazione
    result = await provaGenerazione(result.errore + ' — rispetta id del catalogo, nessun duplicato, ' + payload.nSlots + ' slot.');
  }

  if (result.ok) {
    return res.status(200).json({ ok: true, draft: result.draft, tentativi: result.registro });
  }
  return res.status(502).json({
    ok: false,
    errore: result.errore || 'Generazione fallita',
    tentativi: result.registro,
    dettaglio: result.dettaglio || null
  });
};
