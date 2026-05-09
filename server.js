/**
 * Radar de Vida v7 — server.js
 * Versão ES Module compatível com package.json contendo "type": "module"
 *
 * Backend Render / Node.js / Express
 *
 * Função:
 * - Receber mensagens do WhatsApp no endpoint /webhook/whatsapp
 * - Encaminhar a frase livre para o Apps Script v7
 * - O Apps Script salva no Google Docs, chama a OpenAI e devolve JSON semântico
 */

import express from 'express';

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;

const GOOGLE_DOCS_API_URL = process.env.GOOGLE_DOCS_API_URL || '';

const SEND_WHATSAPP_CONFIRMATION =
  String(process.env.SEND_WHATSAPP_CONFIRMATION || 'false').toLowerCase() === 'true';

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value) {
  return String(value || '').trim();
}

function getClientIp(req) {
  return req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';
}

function extractWhatsappMessage(req) {
  const body = req.body || {};

  const text =
    cleanText(body.Body) ||
    cleanText(body.body) ||
    cleanText(body.text) ||
    cleanText(body.message) ||
    cleanText(body.input) ||
    cleanText(body.frase);

  const from =
    cleanText(body.From) ||
    cleanText(body.from) ||
    cleanText(body.sender) ||
    cleanText(body.phone) ||
    cleanText(body.remoteJid);

  const profileName =
    cleanText(body.ProfileName) ||
    cleanText(body.profileName) ||
    cleanText(body.name) ||
    '';

  return {
    text,
    from,
    profileName,
    raw: body
  };
}

function requireGoogleDocsApiUrl() {
  if (!GOOGLE_DOCS_API_URL) {
    throw new Error(
      'GOOGLE_DOCS_API_URL não configurada no Render. Configure a URL do Web App do Apps Script v7 terminada em /exec.'
    );
  }

  if (!GOOGLE_DOCS_API_URL.includes('/exec')) {
    console.warn(
      '[WARN] GOOGLE_DOCS_API_URL não parece terminar com /exec. URL atual:',
      GOOGLE_DOCS_API_URL
    );
  }
}

async function sendToAppsScript({ text, from, profileName, source, raw }) {
  requireGoogleDocsApiUrl();

  const payload = {
    text,
    from,
    profileName,
    source: source || 'render_whatsapp',
    origem: source || 'render_whatsapp',
    receivedAt: nowIso(),
    raw
  };

  const response = await fetch(GOOGLE_DOCS_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const responseText = await response.text();

  let parsed;

  try {
    parsed = JSON.parse(responseText);
  } catch (err) {
    parsed = {
      ok: false,
      error: 'Resposta do Apps Script não era JSON válido.',
      rawResponse: responseText
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      httpStatus: response.status,
      appsScript: parsed
    };
  }

  return parsed;
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildWhatsappXmlResponse(result) {
  const ok = result && result.ok;
  const id = result && result.id ? result.id : '';

  const message = ok
    ? `Radar de Vida registrado com sucesso.${id ? ` ID: ${id}` : ''}`
    : 'Recebi sua mensagem, mas houve erro ao registrar no Radar de Vida.';

  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(
    message
  )}</Message></Response>`;
}

app.get('/', (req, res) => {
  res.json({
    ok: true,
    app: 'Radar de Vida v7 — Render Bridge',
    status: 'online',
    now: nowIso(),
    endpoints: {
      health: '/health',
      test: '/test',
      whatsapp: '/webhook/whatsapp',
      manualEntry: '/api/manual-entry'
    },
    config: {
      hasGoogleDocsApiUrl: Boolean(GOOGLE_DOCS_API_URL),
      sendWhatsappConfirmation: SEND_WHATSAPP_CONFIRMATION
    }
  });
});

app.get('/health', async (req, res) => {
  const base = {
    ok: true,
    app: 'Radar de Vida v7 — Render Bridge',
    status: 'online',
    now: nowIso(),
    hasGoogleDocsApiUrl: Boolean(GOOGLE_DOCS_API_URL),
    sendWhatsappConfirmation: SEND_WHATSAPP_CONFIRMATION
  };

  if (!GOOGLE_DOCS_API_URL) {
    return res.status(200).json({
      ...base,
      appsScript: {
        ok: false,
        error: 'GOOGLE_DOCS_API_URL ainda não configurada.'
      }
    });
  }

  try {
    const healthUrl = `${GOOGLE_DOCS_API_URL}?action=health`;
    const response = await fetch(healthUrl);
    const text = await response.text();

    let parsed;

    try {
      parsed = JSON.parse(text);
    } catch (err) {
      parsed = {
        ok: false,
        error: 'Resposta health do Apps Script não era JSON.',
        rawResponse: text
      };
    }

    return res.status(200).json({
      ...base,
      appsScript: parsed
    });
  } catch (err) {
    return res.status(200).json({
      ...base,
      appsScript: {
        ok: false,
        error: err.message
      }
    });
  }
});

app.get('/test', async (req, res) => {
  const text =
    cleanText(req.query.text) ||
    'Gastei 25 reais com café, caminhei 20 minutos e trabalhei 1 hora no Radar de Vida.';

  try {
    const result = await sendToAppsScript({
      text,
      from: 'render_test',
      profileName: 'Teste Render',
      source: 'render_test_get',
      raw: {
        query: req.query,
        ip: getClientIp(req)
      }
    });

    return res.status(result.ok ? 200 : 500).json({
      ok: Boolean(result.ok),
      sentText: text,
      result
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message,
      sentText: text
    });
  }
});

app.post('/api/manual-entry', async (req, res) => {
  const text =
    cleanText(req.body.text) ||
    cleanText(req.body.message) ||
    cleanText(req.body.frase);

  if (!text) {
    return res.status(400).json({
      ok: false,
      error: 'Campo text/message/frase vazio.'
    });
  }

  try {
    const result = await sendToAppsScript({
      text,
      from: cleanText(req.body.from) || 'manual_api',
      profileName: cleanText(req.body.profileName) || 'Manual API',
      source: 'render_manual_api',
      raw: {
        body: req.body,
        ip: getClientIp(req)
      }
    });

    return res.status(result.ok ? 200 : 500).json({
      ok: Boolean(result.ok),
      result
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.post('/webhook/whatsapp', async (req, res) => {
  const incoming = extractWhatsappMessage(req);

  console.log('[WHATSAPP] Mensagem recebida:', {
    at: nowIso(),
    from: incoming.from,
    profileName: incoming.profileName,
    text: incoming.text
  });

  if (!incoming.text) {
    const result = {
      ok: false,
      error: 'Mensagem vazia ou formato não reconhecido.',
      receivedBody: req.body
    };

    if (SEND_WHATSAPP_CONFIRMATION) {
      return res
        .status(200)
        .type('text/xml')
        .send(buildWhatsappXmlResponse(result));
    }

    return res.status(200).json(result);
  }

  try {
    const result = await sendToAppsScript({
      text: incoming.text,
      from: incoming.from,
      profileName: incoming.profileName,
      source: 'whatsapp_render',
      raw: {
        body: incoming.raw,
        headers: {
          'user-agent': req.headers['user-agent'],
          'x-forwarded-for': req.headers['x-forwarded-for']
        }
      }
    });

    console.log('[RADAR] Resultado Apps Script:', {
      ok: result.ok,
      id: result.id,
      error: result.error || null
    });

    if (SEND_WHATSAPP_CONFIRMATION) {
      return res
        .status(200)
        .type('text/xml')
        .send(buildWhatsappXmlResponse(result));
    }

    return res.status(200).json({
      ok: Boolean(result.ok),
      received: {
        from: incoming.from,
        profileName: incoming.profileName,
        text: incoming.text
      },
      result
    });
  } catch (err) {
    console.error('[ERRO] Falha no webhook WhatsApp:', err);

    const result = {
      ok: false,
      error: err.message
    };

    if (SEND_WHATSAPP_CONFIRMATION) {
      return res
        .status(200)
        .type('text/xml')
        .send(buildWhatsappXmlResponse(result));
    }

    return res.status(500).json(result);
  }
});

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: 'Endpoint não encontrado.',
    path: req.path
  });
});

app.listen(PORT, () => {
  console.log(`Radar de Vida v7 — Render Bridge online na porta ${PORT}`);
  console.log('GOOGLE_DOCS_API_URL configurada:', Boolean(GOOGLE_DOCS_API_URL));
  console.log('SEND_WHATSAPP_CONFIRMATION:', SEND_WHATSAPP_CONFIRMATION);
});
