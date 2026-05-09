/**
 * Radar de Vida v7.4 — server.js
 * Render + Express + Google Docs Apps Script + Radar Visual Automático
 *
 * Mantém:
 * - Painel visual em /
 * - Texto WhatsApp → Apps Script → Google Docs
 * - /health
 * - /test
 * - /api/manual-entry
 * - /webhook/whatsapp
 *
 * Novo em v7.4:
 * - Foto no WhatsApp é analisada automaticamente.
 * - A análise visual é salva automaticamente no Radar.
 * - Não exige mais aprovação manual via WhatsApp.
 * - Ainda preserva internamente a lógica de pendência + aprovação automática,
 *   usando o Código.gs unificado v7.3 já instalado.
 *
 * Variáveis no Render:
 * GOOGLE_DOCS_API_URL=https://script.google.com/macros/s/SEU_WEBAPP/exec
 * OPENAI_API_KEY=sua_chave_openai
 * OPENAI_VISION_MODEL=gpt-4.1-mini
 * WHATSAPP_CLOUD_TOKEN=token da Meta/WhatsApp Cloud API
 * SEND_WHATSAPP_CONFIRMATION=true ou false
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
app.use(express.json({ limit: '10mb' }));

const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

const PORT = process.env.PORT || 3000;

const GOOGLE_DOCS_API_URL = process.env.GOOGLE_DOCS_API_URL || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4.1-mini';

const WHATSAPP_CLOUD_TOKEN =
  process.env.WHATSAPP_CLOUD_TOKEN ||
  process.env.WHATSAPP_TOKEN ||
  '';

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

function extractTextFromKnownPaths(body) {
  const paths = [
    'Body',
    'body.Body',
    'message.Body',

    'text',
    'body',
    'message',
    'input',
    'frase',
    'content',
    'caption',

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

    'entry[0].changes[0].value.messages[0].text.body',
    'entry[0].changes[0].value.messages[0].button.text',
    'entry[0].changes[0].value.messages[0].interactive.button_reply.title',
    'entry[0].changes[0].value.messages[0].interactive.list_reply.title',
    'entry[0].changes[0].value.messages[0].image.caption',
    'entry[0].changes[0].value.messages[0].document.caption',

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
      return { text, sourcePath: p };
    }
  }

  return { text: '', sourcePath: '' };
}

function extractFromFromKnownPaths(body) {
  const paths = [
    'From',
    'from',
    'sender',
    'phone',
    'remoteJid',
    'waId',
    'wa_id',

    'entry[0].changes[0].value.messages[0].from',
    'entry[0].changes[0].value.contacts[0].wa_id',

    'data.key.remoteJid',
    'data.sender',
    'data.from',
    'data.remoteJid',
    'key.remoteJid',

    'messages[0].from',
    'messages[0].sender',
    'messages[0].phone'
  ];

  for (const p of paths) {
    const value = cleanText(getByPath(body, p));
    if (value) return { from: value, sourcePath: p };
  }

  return { from: '', sourcePath: '' };
}

function extractProfileNameFromKnownPaths(body) {
  const paths = [
    'ProfileName',
    'profileName',
    'name',
    'pushName',
    'notifyName',

    'entry[0].changes[0].value.contacts[0].profile.name',

    'data.pushName',
    'data.senderName',
    'data.name',
    'contact.name',
    'contacts[0].profile.name'
  ];

  for (const p of paths) {
    const value = cleanText(getByPath(body, p));
    if (value) return { profileName: value, sourcePath: p };
  }

  return { profileName: '', sourcePath: '' };
}

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
      /\b(gastei|ganhei|fiz|caminhei|corri|trabalhei|estudei|paguei|recebi|hoje|ontem|aprovar|descartar)\b/i.test(s);

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
      ) continue;

      const found = deepFindTextCandidate(obj[key], depth + 1);
      if (found) return found;
    }
  }

  return '';
}

function extractWhatsappMessage(req) {
  const body = req.body || {};

  const textKnown = extractTextFromKnownPaths(body);
  const fromKnown = extractFromFromKnownPaths(body);
  const profileKnown = extractProfileNameFromKnownPaths(body);
  const mediaKnown = extractMediaFromKnownPaths(body);

  let text = textKnown.text;
  let textSource = textKnown.sourcePath;

  if (!text) {
    const fallbackText = deepFindTextCandidate(body);
    if (fallbackText) {
      text = fallbackText;
      textSource = 'deepFindTextCandidate';
    }
  }

  return {
    text,
    from: fromKnown.from,
    profileName: profileKnown.profileName,
    media: mediaKnown.media,
    source: {
      textPath: textSource,
      fromPath: fromKnown.sourcePath,
      profileNamePath: profileKnown.sourcePath,
      mediaPath: mediaKnown.sourcePath
    },
    raw: body
  };
}

function extractMediaFromKnownPaths(body) {
  const twilioMediaUrl = cleanText(body.MediaUrl0);
  const twilioMediaType = cleanText(body.MediaContentType0);

  if (twilioMediaUrl) {
    return {
      media: {
        type: twilioMediaType || 'image',
        url: twilioMediaUrl,
        id: '',
        mimeType: twilioMediaType || ''
      },
      sourcePath: 'MediaUrl0'
    };
  }

  const cloudImageId = cleanText(getByPath(body, 'entry[0].changes[0].value.messages[0].image.id'));
  const cloudImageMime = cleanText(getByPath(body, 'entry[0].changes[0].value.messages[0].image.mime_type'));

  if (cloudImageId) {
    return {
      media: {
        type: 'image',
        url: '',
        id: cloudImageId,
        mimeType: cloudImageMime || 'image/jpeg',
        provider: 'whatsapp_cloud'
      },
      sourcePath: 'entry[0].changes[0].value.messages[0].image.id'
    };
  }

  const directPaths = [
    'mediaUrl',
    'media.url',
    'image.url',
    'imageUrl',
    'data.mediaUrl',
    'data.media.url',
    'data.image.url',
    'data.imageUrl',
    'message.image.url',
    'message.imageUrl',
    'messages[0].image.url',
    'messages[0].mediaUrl',
    'url'
  ];

  for (const p of directPaths) {
    const url = cleanText(getByPath(body, p));
    if (url && /^https?:\/\//i.test(url)) {
      return {
        media: {
          type: 'image',
          url,
          id: '',
          mimeType: ''
        },
        sourcePath: p
      };
    }
  }

  const base64Paths = [
    'image.base64',
    'imageBase64',
    'media.base64',
    'data.image.base64',
    'data.base64',
    'base64'
  ];

  for (const p of base64Paths) {
    const b64 = cleanText(getByPath(body, p));
    if (b64 && b64.length > 1000) {
      return {
        media: {
          type: 'image',
          url: '',
          id: '',
          mimeType: 'image/jpeg',
          base64: b64
        },
        sourcePath: p
      };
    }
  }

  return {
    media: null,
    sourcePath: ''
  };
}

function normalizeSenderKey(from) {
  return cleanText(from).replace(/^whatsapp:/i, '').replace(/\D/g, '') || cleanText(from) || 'unknown_sender';
}

function isApprovalText(text) {
  const s = cleanText(text).toLowerCase();
  return ['1', 'sim', 'ok', 'aprovar', 'aprovado', 'aprovar foto', 'salvar', 'salvar foto'].includes(s);
}

function isRejectionText(text) {
  const s = cleanText(text).toLowerCase();
  return ['2', 'não', 'nao', 'descartar', 'descarta', 'excluir', 'cancelar', 'rejeitar'].includes(s);
}

function requireGoogleDocsApiUrl() {
  if (!GOOGLE_DOCS_API_URL) {
    throw new Error('GOOGLE_DOCS_API_URL não configurada no Render.');
  }

  if (!GOOGLE_DOCS_API_URL.includes('/exec')) {
    console.warn('[WARN] GOOGLE_DOCS_API_URL não parece terminar com /exec:', GOOGLE_DOCS_API_URL);
  }
}

async function callAppsScript(payload) {
  requireGoogleDocsApiUrl();

  const response = await fetch(GOOGLE_DOCS_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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

async function sendTextToAppsScript({ text, from, profileName, source, raw }) {
  return callAppsScript({
    text,
    from,
    profileName,
    source: source || 'render_whatsapp',
    origem: source || 'render_whatsapp',
    receivedAt: nowIso(),
    raw
  });
}

async function createPendingMediaInAppsScript({ pendingId, senderKey, from, profileName, originalText, mediaInfo, analysis, raw }) {
  return callAppsScript({
    action: 'create_pending_media',
    pendingId,
    senderKey,
    from,
    profileName,
    originalText,
    mediaInfo,
    analysis,
    source: 'whatsapp_visual_pending',
    origem: 'whatsapp_visual_pending',
    receivedAt: nowIso(),
    raw
  });
}

async function approveLatestPendingInAppsScript({ senderKey, from, profileName, raw }) {
  return callAppsScript({
    action: 'approve_latest_pending_media',
    senderKey,
    from,
    profileName,
    source: 'whatsapp_visual_auto_approval',
    origem: 'whatsapp_visual_auto_approval',
    receivedAt: nowIso(),
    raw
  });
}

async function rejectLatestPendingInAppsScript({ senderKey, from, profileName, raw }) {
  return callAppsScript({
    action: 'reject_latest_pending_media',
    senderKey,
    from,
    profileName,
    source: 'whatsapp_visual_rejection',
    origem: 'whatsapp_visual_rejection',
    receivedAt: nowIso(),
    raw
  });
}

async function getImageDataUrl(media) {
  if (!media) throw new Error('Mídia inexistente.');

  if (media.base64) {
    const mime = media.mimeType || 'image/jpeg';
    const clean = String(media.base64).includes(',')
      ? String(media.base64).split(',').pop()
      : String(media.base64);

    return `data:${mime};base64,${clean}`;
  }

  if (media.provider === 'whatsapp_cloud' && media.id) {
    if (!WHATSAPP_CLOUD_TOKEN) {
      throw new Error('Imagem da WhatsApp Cloud API exige WHATSAPP_CLOUD_TOKEN no Render.');
    }

    const metaRes = await fetch(`https://graph.facebook.com/v19.0/${media.id}?fields=url,mime_type,file_size,sha256`, {
      headers: { Authorization: `Bearer ${WHATSAPP_CLOUD_TOKEN}` }
    });

    if (!metaRes.ok) {
      const errText = await metaRes.text();
      throw new Error(`Falha ao buscar metadados da mídia WhatsApp Cloud: ${metaRes.status} — ${errText.slice(0, 500)}`);
    }

    const meta = await metaRes.json();
    const url = meta.url;

    if (!url) {
      throw new Error('WhatsApp Cloud não retornou URL de mídia.');
    }

    const imgRes = await fetch(url, {
      headers: { Authorization: `Bearer ${WHATSAPP_CLOUD_TOKEN}` }
    });

    if (!imgRes.ok) {
      const errText = await imgRes.text();
      throw new Error(`Falha ao baixar mídia WhatsApp Cloud: ${imgRes.status} — ${errText.slice(0, 500)}`);
    }

    const arrayBuffer = await imgRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const mime = meta.mime_type || media.mimeType || imgRes.headers.get('content-type') || 'image/jpeg';

    return `data:${mime};base64,${buffer.toString('base64')}`;
  }

  if (media.url) {
    const headers = {};

    const twilioSid = process.env.TWILIO_ACCOUNT_SID || '';
    const twilioToken = process.env.TWILIO_AUTH_TOKEN || '';

    if (/twilio/i.test(media.url) && twilioSid && twilioToken) {
      headers.Authorization = 'Basic ' + Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64');
    }

    const res = await fetch(media.url, { headers });

    if (!res.ok) {
      throw new Error(`Falha ao baixar imagem por URL: HTTP ${res.status}`);
    }

    const contentType = media.mimeType || res.headers.get('content-type') || 'image/jpeg';
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    return `data:${contentType};base64,${buffer.toString('base64')}`;
  }

  throw new Error('Formato de mídia não suportado para download.');
}

async function analyzeImageWithOpenAI({ imageDataUrl, caption, from, profileName }) {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY não configurada no Render.');
  }

  const prompt = [
    'Você é o motor visual do Radar de Vida.',
    'Analise a imagem enviada pelo usuário como uma memória visual da vida real.',
    'Não identifique pessoas. Não faça inferências sensíveis sobre identidade, saúde, religião, política ou intimidade.',
    'Transforme a imagem em JSON útil para diário semântico, tendências e insights.',
    'Se houver recibo, tela, objeto, local, ferramenta, comida, natureza, trabalho, manutenção ou projeto, descreva com prudência.',
    'Não invente valores de dinheiro ou tempo se não estiverem claramente visíveis.',
    'A imagem será salva automaticamente no diário semântico do usuário, então seja prudente, útil e objetivo.',
    'Responda SOMENTE com JSON válido, sem markdown.',
    '',
    'Campos obrigatórios:',
    '{',
    '  "tipo_input": "foto",',
    '  "descricao_visual": "descrição objetiva e curta",',
    '  "hipotese_de_contexto": "interpretação prudente do que isso pode representar",',
    '  "categorias": ["..."],',
    '  "projetos_detectados": ["..."],',
    '  "lugares_detectados": ["..."],',
    '  "dinheiro_gasto": 0,',
    '  "dinheiro_ganho": 0,',
    '  "dinheiro_investido": 0,',
    '  "tempo_estimado_minutos": 0,',
    '  "tom_emocional": "positivo|neutro|negativo|misto|indefinido",',
    '  "impacto_geral": "positivo|neutro|negativo|misto|indefinido",',
    '  "dimensoes_afetadas": ["..."],',
    '  "insight_curto": "insight útil e surpreendente",',
    '  "insight_profundo": "leitura mais estratégica",',
    '  "sugestao_pratica": "próxima ação simples",',
    '  "confianca": "alta|media|baixa",',
    '  "frase_sugerida_para_salvar": "frase em primeira pessoa resumindo a foto como registro de vida"',
    '}',
    '',
    'Legenda/texto enviado junto da imagem:',
    caption || '',
    '',
    'Remetente:',
    from || '',
    profileName || ''
  ].join('\n');

  const payload = {
    model: OPENAI_VISION_MODEL,
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: prompt },
          { type: 'input_image', image_url: imageDataUrl }
        ]
      }
    ]
  };

  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const body = await res.text();

  if (!res.ok) {
    throw new Error(`OpenAI Vision HTTP ${res.status}: ${body.slice(0, 1000)}`);
  }

  const parsed = JSON.parse(body);
  const outputText = extractOpenAIText(parsed);

  if (!outputText) {
    throw new Error('OpenAI Vision não retornou output_text.');
  }

  return parsePossiblyWrappedJson(outputText);
}

function extractOpenAIText(response) {
  if (!response) return '';

  if (response.output_text) return String(response.output_text);

  if (response.output && response.output.length) {
    const parts = [];

    response.output.forEach(item => {
      if (item.content && item.content.length) {
        item.content.forEach(c => {
          if (c.text) parts.push(c.text);
          if (c.type === 'output_text' && c.text) parts.push(c.text);
        });
      }
    });

    if (parts.length) return parts.join('\n');
  }

  return '';
}

function parsePossiblyWrappedJson(text) {
  const raw = String(text || '').trim();

  try {
    return JSON.parse(raw);
  } catch {}

  const withoutFence = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(withoutFence);
  } catch {}

  const firstBrace = withoutFence.indexOf('{');

  if (firstBrace === -1) {
    throw new Error('Nenhum JSON encontrado na resposta visual.');
  }

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = firstBrace; i < withoutFence.length; i++) {
    const ch = withoutFence[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === '\\') {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (ch === '{') depth++;
      if (ch === '}') depth--;

      if (depth === 0) {
        return JSON.parse(withoutFence.slice(firstBrace, i + 1));
      }
    }
  }

  throw new Error('JSON visual incompleto.');
}

function enhanceVisualAnalysisForAutoSave(analysis) {
  const a = analysis || {};

  const categorias = Array.isArray(a.categorias) ? [...a.categorias] : [];
  categorias.push('foto');
  categorias.push('registro visual');
  categorias.push('foto_analisada_automaticamente');

  const dimensoes = Array.isArray(a.dimensoes_afetadas) ? [...a.dimensoes_afetadas] : [];
  dimensoes.push('memoria_visual');

  return {
    ...a,
    categorias: Array.from(new Set(categorias.filter(Boolean))),
    dimensoes_afetadas: Array.from(new Set(dimensoes.filter(Boolean))),
    visual_auto: true,
    precisa_revisao: true,
    origem_visual: 'whatsapp_visual_auto',
    insight_curto:
      a.insight_curto ||
      'Registro visual salvo automaticamente a partir de foto enviada pelo WhatsApp.',
    frase_sugerida_para_salvar:
      a.frase_sugerida_para_salvar ||
      a.hipotese_de_contexto ||
      a.descricao_visual ||
      'Enviei uma foto ao Radar de Vida para registro visual automático.'
  };
}

function buildAutoSaveConfirmationText(analysis, entryId) {
  const insight = analysis.insight_curto || analysis.descricao_visual || 'Foto analisada e salva.';
  const cats = Array.isArray(analysis.categorias) ? analysis.categorias.slice(0, 5).join(', ') : '';

  return [
    '📷 Radar Visual salvou sua foto automaticamente.',
    '',
    `Insight: ${insight}`,
    cats ? `Categorias: ${cats}` : '',
    entryId ? `ID: ${entryId}` : '',
    '',
    'Se não gostar da leitura, você pode excluir depois pelo painel.'
  ].filter(Boolean).join('\n');
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildWhatsappXmlMessage(message) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(message)}</Message></Response>`;
}

function buildWhatsappXmlResponse(result) {
  const ok = result && result.ok;
  const id = result && result.id ? result.id : '';

  const message = ok
    ? `Radar de Vida registrado com sucesso.${id ? ` ID: ${id}` : ''}`
    : 'Recebi sua mensagem, mas houve erro ao registrar no Radar de Vida.';

  return buildWhatsappXmlMessage(message);
}

app.get('/', (req, res) => {
  const indexPath = path.join(publicDir, 'index.html');

  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }

  return res.json({
    ok: true,
    app: 'Radar de Vida v7.4 — Radar Visual Automático',
    status: 'online',
    now: nowIso(),
    message: 'Backend online, mas public/index.html não foi encontrado.',
    expectedFile: 'public/index.html',
    endpoints: {
      health: '/health',
      test: '/test',
      whatsapp: '/webhook/whatsapp',
      manualEntry: '/api/manual-entry'
    },
    config: {
      hasGoogleDocsApiUrl: Boolean(GOOGLE_DOCS_API_URL),
      hasOpenAiApiKey: Boolean(OPENAI_API_KEY),
      hasWhatsappCloudToken: Boolean(WHATSAPP_CLOUD_TOKEN),
      openaiVisionModel: OPENAI_VISION_MODEL,
      sendWhatsappConfirmation: SEND_WHATSAPP_CONFIRMATION,
      logRawWhatsappEmpty: LOG_RAW_WHATSAPP_EMPTY
    }
  });
});

app.get('/health', async (req, res) => {
  const base = {
    ok: true,
    app: 'Radar de Vida v7.4 — Radar Visual Automático',
    status: 'online',
    now: nowIso(),
    hasGoogleDocsApiUrl: Boolean(GOOGLE_DOCS_API_URL),
    hasOpenAiApiKey: Boolean(OPENAI_API_KEY),
    hasWhatsappCloudToken: Boolean(WHATSAPP_CLOUD_TOKEN),
    openaiVisionModel: OPENAI_VISION_MODEL,
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
    } catch {
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
    const result = await sendTextToAppsScript({
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
    const result = await sendTextToAppsScript({
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
  const senderKey = normalizeSenderKey(incoming.from);

  console.log('[WHATSAPP] Mensagem recebida:', {
    at: nowIso(),
    from: incoming.from,
    profileName: incoming.profileName,
    text: incoming.text,
    hasMedia: Boolean(incoming.media),
    media: incoming.media
      ? {
          type: incoming.media.type,
          id: incoming.media.id,
          url: incoming.media.url ? '[url]' : '',
          mimeType: incoming.media.mimeType,
          provider: incoming.media.provider || ''
        }
      : null,
    source: incoming.source
  });

  /**
   * Mantemos aprovação/rejeição para compatibilidade com pendências antigas.
   * Mas o fluxo novo de foto salva automaticamente.
   */
  if (incoming.text && isApprovalText(incoming.text)) {
    try {
      const result = await approveLatestPendingInAppsScript({
        senderKey,
        from: incoming.from,
        profileName: incoming.profileName,
        raw: {
          body: incoming.raw,
          source: incoming.source
        }
      });

      const msg = result.ok
        ? '✅ Foto pendente aprovada e salva no Radar de Vida.'
        : 'Não encontrei foto pendente para aprovar. As novas fotos agora são salvas automaticamente.';

      if (SEND_WHATSAPP_CONFIRMATION) {
        return res.status(200).type('text/xml').send(buildWhatsappXmlMessage(msg));
      }

      return res.status(200).json({
        ok: Boolean(result.ok),
        action: 'approve_pending_media',
        result
      });
    } catch (err) {
      if (SEND_WHATSAPP_CONFIRMATION) {
        return res.status(200).type('text/xml').send(buildWhatsappXmlMessage('Erro ao aprovar foto: ' + err.message));
      }

      return res.status(500).json({
        ok: false,
        error: err.message
      });
    }
  }

  if (incoming.text && isRejectionText(incoming.text)) {
    try {
      const result = await rejectLatestPendingInAppsScript({
        senderKey,
        from: incoming.from,
        profileName: incoming.profileName,
        raw: {
          body: incoming.raw,
          source: incoming.source
        }
      });

      const msg = result.ok
        ? '🗑️ Foto pendente descartada.'
        : 'Não encontrei foto pendente para descartar. As novas fotos agora são salvas automaticamente; exclua pelo painel se necessário.';

      if (SEND_WHATSAPP_CONFIRMATION) {
        return res.status(200).type('text/xml').send(buildWhatsappXmlMessage(msg));
      }

      return res.status(200).json({
        ok: Boolean(result.ok),
        action: 'reject_pending_media',
        result
      });
    } catch (err) {
      if (SEND_WHATSAPP_CONFIRMATION) {
        return res.status(200).type('text/xml').send(buildWhatsappXmlMessage('Erro ao descartar foto: ' + err.message));
      }

      return res.status(500).json({
        ok: false,
        error: err.message
      });
    }
  }

  /**
   * Fluxo novo v7.4:
   * Foto analisada e salva automaticamente.
   */
  if (incoming.media) {
    const pendingId = 'rdv_media_' + Date.now() + '_' + Math.random().toString(16).slice(2, 10);

    try {
      const imageDataUrl = await getImageDataUrl(incoming.media);

      const rawAnalysis = await analyzeImageWithOpenAI({
        imageDataUrl,
        caption: incoming.text,
        from: incoming.from,
        profileName: incoming.profileName
      });

      const analysis = enhanceVisualAnalysisForAutoSave(rawAnalysis);

      const pendingResult = await createPendingMediaInAppsScript({
        pendingId,
        senderKey,
        from: incoming.from,
        profileName: incoming.profileName,
        originalText: incoming.text,
        mediaInfo: {
          type: incoming.media.type || 'image',
          mimeType: incoming.media.mimeType || '',
          sourcePath: incoming.source.mediaPath || '',
          provider: incoming.media.provider || '',
          autoSave: true
        },
        analysis,
        raw: {
          body: incoming.raw,
          source: incoming.source,
          autoSave: true
        }
      });

      if (!pendingResult.ok) {
        console.error('[RADAR_VISUAL_AUTO] Pendência não criada:', pendingResult);

        const msg = 'Recebi e analisei a foto, mas não consegui criar o registro no Google Docs.';

        if (SEND_WHATSAPP_CONFIRMATION) {
          return res.status(200).type('text/xml').send(buildWhatsappXmlMessage(msg));
        }

        return res.status(200).json({
          ok: false,
          action: 'visual_auto_pending_failed',
          pendingId,
          result: pendingResult
        });
      }

      const approveResult = await approveLatestPendingInAppsScript({
        senderKey,
        from: incoming.from,
        profileName: incoming.profileName,
        raw: {
          body: incoming.raw,
          source: incoming.source,
          autoApproved: true,
          pendingId
        }
      });

      console.log('[RADAR_VISUAL_AUTO] Foto analisada e salva automaticamente:', {
        pendingOk: pendingResult.ok,
        approveOk: approveResult.ok,
        pendingId,
        entryId: approveResult.entryId || null,
        senderKey,
        error: approveResult.error || null
      });

      const confirmationText = buildAutoSaveConfirmationText(
        analysis,
        approveResult.entryId || ''
      );

      if (SEND_WHATSAPP_CONFIRMATION) {
        return res.status(200).type('text/xml').send(buildWhatsappXmlMessage(confirmationText));
      }

      return res.status(200).json({
        ok: Boolean(approveResult.ok),
        action: 'visual_auto_saved',
        pendingId,
        entryId: approveResult.entryId || '',
        analysis,
        pendingResult,
        approveResult
      });

    } catch (err) {
      console.error('[RADAR_VISUAL_AUTO] Erro ao analisar/salvar imagem:', err);

      const msg = 'Recebi a foto, mas ainda não consegui analisá-la. Erro: ' + err.message;

      if (SEND_WHATSAPP_CONFIRMATION) {
        return res.status(200).type('text/xml').send(buildWhatsappXmlMessage(msg));
      }

      return res.status(200).json({
        ok: false,
        action: 'visual_auto_failed',
        pendingId,
        error: err.message,
        hint: 'Verifique OPENAI_API_KEY, WHATSAPP_CLOUD_TOKEN, URL da mídia ou permissões da Meta.'
      });
    }
  }

  /**
   * Texto comum.
   */
  if (!incoming.text) {
    console.warn('[WHATSAPP] Mensagem vazia ou formato não reconhecido.');

    if (LOG_RAW_WHATSAPP_EMPTY) {
      console.warn('[WHATSAPP_RAW_EMPTY]', safeJson(req.body));
    }

    const result = {
      ok: false,
      error: 'Mensagem vazia ou formato não reconhecido.',
      hint: 'Verifique o log [WHATSAPP_RAW_EMPTY] no Render.',
      detectedSource: incoming.source
    };

    if (SEND_WHATSAPP_CONFIRMATION) {
      return res.status(200).type('text/xml').send(buildWhatsappXmlResponse(result));
    }

    return res.status(200).json(result);
  }

  try {
    const result = await sendTextToAppsScript({
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
      return res.status(200).type('text/xml').send(buildWhatsappXmlResponse(result));
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
      return res.status(200).type('text/xml').send(buildWhatsappXmlResponse(result));
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
  console.log(`Radar de Vida v7.4 — Radar Visual Automático online na porta ${PORT}`);
  console.log('GOOGLE_DOCS_API_URL configurada:', Boolean(GOOGLE_DOCS_API_URL));
  console.log('OPENAI_API_KEY configurada no Render:', Boolean(OPENAI_API_KEY));
  console.log('WHATSAPP_CLOUD_TOKEN configurado no Render:', Boolean(WHATSAPP_CLOUD_TOKEN));
  console.log('OPENAI_VISION_MODEL:', OPENAI_VISION_MODEL);
  console.log('SEND_WHATSAPP_CONFIRMATION:', SEND_WHATSAPP_CONFIRMATION);
  console.log('LOG_RAW_WHATSAPP_EMPTY:', LOG_RAW_WHATSAPP_EMPTY);
  console.log('public/index.html encontrado:', fs.existsSync(path.join(publicDir, 'index.html')));
});
