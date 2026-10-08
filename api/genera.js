// api/genera.js
// Funzione serverless Vercel: TEST robusto del collegamento a Gemini
// (nuovi tentativi automatici + modello di riserva).
// La chiave resta nelle Environment Variables di Vercel, mai nel codice.
//
// Variabili d'ambiente (Vercel > Settings > Environment Variables):
//   GEMINI_API_KEY         (obbligatoria) chiave creata in Google AI Studio
//   GEMINI_MODEL           (obbligatoria) modello principale
//   GEMINI_MODEL_FALLBACK  (facoltativa)  modello di riserva, usato se il principale non risponde
//   STAFF_CODE             (facoltativa)  se impostata, serve ?codice=... per usare la funzione

const STATI_TEMPORANEI = [429, 500, 502, 503, 504]; // errori che vale la pena riprovare
const TENTATIVI_PER_MODELLO = 2;
const PAUSA_MS = 1500;
const TIMEOUT_MS = 12000;

const attendi = (ms) => new Promise((r) => setTimeout(r, ms));

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
    try {
      dati = await r.json();
    } catch (e) {
      dati = null;
    }
    return { ok: r.ok, stato: r.status, dati: dati };
  } catch (e) {
    // stato 0 = problema di rete o timeout (trattato come temporaneo)
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

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const chiave = process.env.GEMINI_API_KEY;
  const principale = process.env.GEMINI_MODEL;
  const riserva = process.env.GEMINI_MODEL_FALLBACK;
  if (!chiave || !principale) {
    return res.status(500).json({
      ok: false,
      errore: 'Mancano GEMINI_API_KEY o GEMINI_MODEL nelle Environment Variables di Vercel.'
    });
  }

  // Controllo codice staff (attivo solo se STAFF_CODE e' impostata)
  const richiesto = process.env.STAFF_CODE;
  if (richiesto) {
    const dato = (req.query && req.query.codice) || req.headers['x-staff-code'];
    if (dato !== richiesto) {
      return res.status(401).json({ ok: false, errore: 'Codice non valido.' });
    }
  }

  const corpo = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: 'Rispondi in italiano. Scrivi una frase breve di saluto per un allenatore di calcio giovanile.'
          }
        ]
      }
    ],
    generationConfig: {
      // margine ampio: i modelli con "ragionamento" consumano token anche prima di rispondere
      maxOutputTokens: 1024,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: { messaggio: { type: 'STRING' } },
        required: ['messaggio']
      }
    }
  };

  const modelli = [principale];
  if (riserva && riserva !== principale) modelli.push(riserva);

  const registro = []; // cosa e' successo a ogni tentativo (utile per il debug)
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

        let risposta;
        try {
          risposta = JSON.parse(testo);
        } catch (e) {
          risposta = { grezzo: testo };
        }
        return res.status(200).json({
          ok: true,
          modello: modello,
          usatoModelloDiRiserva: modello !== principale,
          tentativi: registro,
          risposta: risposta
        });
      }

      ultimo = esito;

      // Problemi di richiesta o di chiave: un altro tentativo non li risolve
      if (esito.stato === 400 || esito.stato === 401 || esito.stato === 403) {
        return res.status(502).json({
          ok: false,
          errore: 'Gemini ha rifiutato la richiesta (controlla chiave, permessi o formato).',
          tentativi: registro,
          dettaglio: esito.dati && esito.dati.error ? esito.dati.error.message : esito.dati
        });
      }

      // Errore temporaneo (sovraccarico, troppe richieste, rete): riprova dopo una pausa
      if (STATI_TEMPORANEI.indexOf(esito.stato) !== -1 || esito.stato === 0) {
        if (tentativo < TENTATIVI_PER_MODELLO) await attendi(PAUSA_MS);
        continue;
      }

      // Altro errore (es. 404 modello inesistente): passa al modello successivo
      break;
    }
  }

  return res.status(502).json({
    ok: false,
    errore: 'Gemini non disponibile in questo momento.',
    tentativi: registro,
    dettaglio:
      ultimo && ultimo.dati && ultimo.dati.error
        ? ultimo.dati.error.message
        : ultimo && ultimo.errore
        ? ultimo.errore
        : null
  });
};
