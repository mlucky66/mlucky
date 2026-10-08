// api/genera.js
// Funzione serverless Vercel: TEST del collegamento a Gemini.
// La chiave resta nelle Environment Variables di Vercel, mai nel codice.
//
// Variabili d'ambiente (Vercel > Settings > Environment Variables):
//   GEMINI_API_KEY  (obbligatoria) chiave creata in Google AI Studio
//   GEMINI_MODEL    (obbligatoria) nome del modello, es. un Flash recente
//   STAFF_CODE      (facoltativa)  se impostata, serve ?codice=... per usare la funzione

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const key = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL;
  if (!key || !model) {
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

  try {
    const url =
      'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(model) +
      ':generateContent';

    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key
      },
      body: JSON.stringify({
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
      })
    });

    const dati = await r.json();

    if (!r.ok) {
      return res.status(502).json({
        ok: false,
        errore: 'Errore restituito da Gemini',
        stato: r.status,
        dettaglio: dati && dati.error ? dati.error.message : dati
      });
    }

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

    return res.status(200).json({ ok: true, modello: model, risposta: risposta });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      errore: 'Chiamata a Gemini fallita',
      dettaglio: String((e && e.message) || e)
    });
  }
};
