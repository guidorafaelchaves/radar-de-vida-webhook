/**
 * Radar de Vida v7.2 — server.js
 * Render + Express + Google Docs Apps Script + painel estático
 *
 * Esta versão:
 * 1. Serve o painel visual em /
 *    - arquivo esperado: public/index.html
 *
 * 2. Mantém a API:
 *    - GET  /health
 *    - GET  /test
 *    - POST /webhook/whatsapp
 *    - POST /api/manual-entry
 *
 * 3. Melhora a leitura de mensagens reais do WhatsApp:
 *    - Twilio: Body
 *    - WhatsApp Cloud API: entry[0].changes[0].value.messages[0].text.body
 *    - Z-API / Evolution / Baileys e formatos parecidos
 *    - Payloads genéricos com text/message/body/frase/input
 *
 * Variáveis de ambiente no Render:
 * GOOGLE_DOCS_API_URL=https://script.google.com/macros/s/SEU_WEBAPP/exec
 * SEND_WHATSAPP_CONFIRMATION=false
 * LOG_RAW_WHATSAPP_EMPTY=true
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '5mb' }));

const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

const PORT = process.env.PORT || 3000;

const GOOGLE_DOCS_API_URL = process.env.GOOGLE_DOCS_API_URL || '';

const SEND_WHATSAPP_CONFIRMATION =
  String(process.env.SEND_WHATSAPP_CONFIRMATION || 'false').toLowerCase() === 'true';

const LOG_RAW_WHATSAPP_EMPTY =
  String(process.env.LOG_RAW_WHATSAPP_EMPTY || 'true').toLowerCase() === 'true';

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function getClientIp(req) {
  return req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';
}

function safeJson(value, maxLength = 6000) {
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > maxLength ? text.slice(0, maxLength) + '... [TRUNCADO]' : text;
  } catch (err) {
    return '[Não foi possível serializar JSON]';
  }
}

function getByPath(obj, pathExpression) {
  try {
    return pathExpression.split('.').reduce((acc, key) => {
      if (acc === null || acc === undefined) return undefined;

      if (key.endsWith(']')) {
        const match = key.match(/^(.+)\[(\d+)\]$/);
        if (!match) return acc[key];

        const arrKey = match[1];
        const index = Number(match[2]);

        return acc[arrKey] && acc[arrKey][index];
      }

      return acc[key];
    }, obj);
  } catch (err) {
    return undefined;
  }
}

/**
 * Busca texto em formatos conhecidos.
 */
function extractTextFromKnownPaths(body) {
  const paths = [
    // Twilio
    'Body',
    'body.Body',
    'message.Body',

    // Formatos simples
    'text',
    'body',
    'message',
    'input',
    'frase',
    'content',
    'caption',

    // Objetos comuns
    'data.text',
    'data.body',
    'data.message',
    'data.content',
    'payload.text',
    'payload.body',
    'payload.message',
    'event.text',
    'event.body',
    'event.message',

    // WhatsApp Cloud API oficial
    'entry[0].changes[0].value.messages[0].text.body',
    'entry[0].changes[0].value.messages[0].button.text',
    'entry[0].changes[0].value.messages[0].interactive.button_reply.title',
    'entry[0].changes[0].value.messages[0].interactive.list_reply.title',
    'entry[0].changes[0].value.messages[0].image.caption',
    'entry[0].changes[0].value.messages[0].document.caption',

    // Evolution API / Baileys / WPPConnect e similares
    'data.message.conversation',
    'data.message.extendedTextMessage.text',
    'data.message.imageMessage.caption',
    'data.message.videoMessage.caption',
    'data.message.documentMessage.caption',
    'data.message.buttonsResponseMessage.selectedButtonId',
    'data.message.buttonsResponseMessage.selectedDisplayText',
    'data.message.listResponseMessage.title',
    'data.message.listResponseMessage.singleSelectReply.selectedRowId',

    'message.conversation',
    'message.extendedTextMessage.text',
    'message.imageMessage.caption',
    'message.videoMessage.caption',
    'message.documentMessage.caption',

    'messages[0].text.body',
    'messages[0].body',
    'messages[0].text',
    'messages[0].message',
    'messages[0].content',

    // Z-API e variações
    'text.message',
    'text.body',
    'message.text',
    'message.body',
    'msg.text',
    'msg.body'
  ];

  for (const p of paths) {
    const value = getByPath(body, p);
    const text = cleanText(value);

    if (text) {
      return {
        text,
        sourcePath: p
      };
    }
  }

  return {
    text: '',
    sourcePath: ''
  };
}

/**
 * Busca remetente em formatos conhecidos.
 */
function extractFromFromKnownPaths(body) {
  const paths = [
    // Twilio
    'From',
    'from',
    'sender',
    'phone',
    'remoteJid',
    'waId',
    'wa_id',

    // WhatsApp Cloud API
    'entry[0].changes[0].value.messages[0].from',
    'entry[0].changes[0].value.contacts[0].wa_id',

    // Evolution/Baileys
    'data.key.remoteJid',
    'data.sender',
    'data.from',
    'data.remoteJid',
    'key.remoteJid',

    // Arrays genéricos
    'messages[0].from',
    'messages[0].sender',
    'messages[0].phone'
  ];

  for (const p of paths) {
    const value = cleanText(getByPath(body, p));
    if (value) {
      return {
        from: value,
        sourcePath: p
      };
    }
  }

  return {
    from: '',
    sourcePath: ''
  };
}

/**
 * Busca nome/perfil em formatos conhecidos.
 */
function extractProfileNameFromKnownPaths(body) {
  const paths = [
    // Twilio
    'ProfileName',
    'profileName',
    'name',
    'pushName',
    'notifyName',

    // WhatsApp Cloud API
    'entry[0].changes[0].value.contacts[0].profile.name',

    // Evolution/Baileys
    'data.pushName',
    'data.senderName',
    'data.name',
    'contact.name',
    'contacts[0].profile.name'
  ];

  for (const p of paths) {
    const value = cleanText(getByPath(body, p));
    if (value) {
      return {
        profileName: value,
        sourcePath: p
      };
    }
  }

  return {
    profileName: '',
    sourcePath: ''
  };
}

/**
 * Tentativa final: varre recursivamente o payload procurando campos úteis.
 * Evita usar textos técnicos como IDs, timestamps e URLs.
 */
function deepFindTextCandidate(obj, depth = 0) {
  if (!obj || depth > 5) return '';

  if (typeof obj === 'string') {
    const s = obj.trim();

    if (!s) return '';
    if (s.length > 1000) return '';
    if (/^https?:\/\//i.test(s)) return '';
    if (/^\d{8,}$/.test(s)) return '';
    if (/^[A-Za-z0-9_\-:.@+]{20,}$/.test(s)) return '';

    const looksLikeHumanText =
      s.includes(' ') ||
      /[áàâãéêíóôõúç]/i.test(s) ||
      /\b(gastei|ganhei|fiz|caminhei|corri|trabalhei|estudei|paguei|recebi|hoje|ontem)\b/i.test(s);

    return looksLikeHumanText ? s : '';
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = deepFindTextCandidate(item, depth + 1);
      if (found) return found;
    }
    return '';
  }

  if (typeof obj === 'object') {
    const priorityKeys = [
      'body',
      'text',
      'message',
      'caption',
      'content',
      'conversation',
      'title',
      'selectedDisplayText'
    ];

    for (const key of priorityKeys) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        const found = deepFindTextCandidate(obj[key], depth + 1);
        if (found) return found;
      }
    }

    for (const key of Object.keys(obj)) {
      const lower = key.toLowerCase();

      if (
        lower.includes('id') ||
        lower.includes('token') ||
        lower.includes('secret') ||
        lower.includes('timestamp') ||
        lower.includes('url') ||
        lower.includes('mime') ||
        lower.includes('type')
      ) {
        continue;
      }

      const found = deepFindTextCandidate(obj[key], depth + 1);
      if (found) return found;
    }
  }

  return '';
}

/**
 * Extrator universal de mensagem.
 */
function extractWhatsappMessage(req) {
  const body = req.body || {};

  const textKnown = extractTextFromKnownPaths(body);
  const fromKnown = extractFromFromKnownPaths(body);
  const profileKnown = extractProfileNameFromKnownPaths(body);

  let text = textKnown.text;
  let textSource = textKnown.sourcePath;

  if (!text) {
    const fallbackText = deepFindTextCandidate(body);
    if (fallbackText) {
      text = fallbackText;
      textSource = 'deepFindTextCandidate';
    }
  }

  const from = fromKnown.from;
  const profileName = profileKnown.profileName;

  return {
    text,
    from,
    profileName,
    source: {
      textPath: textSource,
      fromPath: fromKnown.sourcePath,
      profileNamePath: profileKnown.sourcePath
    },
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

/**
 * Página inicial.
 * Se existir public/index.html, mostra o painel visual.
 * Se não existir, mostra JSON de diagnóstico.
 */
app.get('/', (req, res) => {
  const indexPath = path.join(publicDir, 'index.html');

  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }

  return res.json({
    ok: true,
    app: 'Radar de Vida v7.2 — Render Bridge',
    status: 'online',
    now: nowIso(),
    message: 'Backend online, mas public/index.html não foi encontrado. Crie a pasta public e coloque o index.html dentro dela.',
    expectedFile: 'public/index.html',
    endpoints: {
      health: '/health',
      test: '/test',
      whatsapp: '/webhook/whatsapp',
      manualEntry: '/api/manual-entry'
    },
    config: {
      hasGoogleDocsApiUrl: Boolean(GOOGLE_DOCS_API_URL),
      sendWhatsappConfirmation: SEND_WHATSAPP_CONFIRMATION,
      logRawWhatsappEmpty: LOG_RAW_WHATSAPP_EMPTY
    }
  });
});

app.get('/health', async (req, res) => {
  const base = {
    ok: true,
    app: 'Radar de Vida v7.2 — Render Bridge',
    status: 'online',
    now: nowIso(),
    hasGoogleDocsApiUrl: Boolean(GOOGLE_DOCS_API_URL),
    sendWhatsappConfirmation: SEND_WHATSAPP_CONFIRMATION,
    logRawWhatsappEmpty: LOG_RAW_WHATSAPP_EMPTY,
    hasPublicIndex: fs.existsSync(path.join(publicDir, 'index.html'))
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
    text: incoming.text,
    source: incoming.source
  });

  if (!incoming.text) {
    console.warn('[WHATSAPP] Mensagem vazia ou formato não reconhecido.');

    if (LOG_RAW_WHATSAPP_EMPTY) {
      console.warn('[WHATSAPP_RAW_EMPTY]', safeJson(req.body));
    }

    const result = {
      ok: false,
      error: 'Mensagem vazia ou formato não reconhecido.',
      hint: 'Verifique o log [WHATSAPP_RAW_EMPTY] no Render para identificar o formato real do payload.',
      detectedSource: incoming.source
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
        source: incoming.source,
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
        text: incoming.text,
        source: incoming.source
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
  console.log(`Radar de Vida v7.2 — Render Bridge online na porta ${PORT}`);
  console.log('GOOGLE_DOCS_API_URL configurada:', Boolean(GOOGLE_DOCS_API_URL));
  console.log('SEND_WHATSAPP_CONFIRMATION:', SEND_WHATSAPP_CONFIRMATION);
  console.log('LOG_RAW_WHATSAPP_EMPTY:', LOG_RAW_WHATSAPP_EMPTY);
  console.log('public/index.html encontrado:', fs.existsSync(path.join(publicDir, 'index.html')));
});
