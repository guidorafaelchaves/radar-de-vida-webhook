/**
 * Radar de Vida v7.5 — server.js
 * Render + Express + Google Docs Apps Script + Radar Visual Documental
 *
 * Mantém tudo que já está funcionando:
 * - Painel visual em /
 * - Texto WhatsApp → Apps Script → Google Docs
 * - Fotos WhatsApp → Meta Cloud API → OpenAI Vision → Apps Script → Google Docs
 * - /health
 * - /test
 * - /api/manual-entry
 * - /webhook/whatsapp
 *
 * Novo em v7.5:
 * - Prompt visual/documental muito mais forte.
 * - Melhor leitura de prints financeiros, recibos, extratos, comprovantes e apps de investimento.
 * - Extração de datas, valores, tickers, nomes, eventos, proventos e somatórios.
 * - Envio direto ao Apps Script usando action=create_visual_entry.
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
app.use(express.json({ limit: '15mb' }));

const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

const PORT = process.env.PORT || 3000;

function pickOpenAiTextModelInfo() {
  const explicit = String(process.env.OPENAI_TEXT_MODEL || '').trim();
  if (explicit) {
    return { model: explicit, source: 'OPENAI_TEXT_MODEL', ignoredLegacyModel: '' };
  }

  const legacy = String(process.env.OPENAI_MODEL || '').trim();
  if (legacy && !/^gpt-5\.4/i.test(legacy)) {
    return { model: legacy, source: 'OPENAI_MODEL', ignoredLegacyModel: '' };
  }

  return {
    model: 'gpt-4.1-mini',
    source: legacy ? 'default_ignored_invalid_OPENAI_MODEL' : 'default',
    ignoredLegacyModel: legacy
  };
}

const GOOGLE_DOCS_API_URL = process.env.GOOGLE_DOCS_API_URL || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4.1-mini';
const OPENAI_TEXT_MODEL_INFO = pickOpenAiTextModelInfo();
const OPENAI_TEXT_MODEL = OPENAI_TEXT_MODEL_INFO.model;
const OPENAI_AUDIO_MODEL = process.env.OPENAI_AUDIO_MODEL || 'gpt-4o-mini-transcribe';

const WHATSAPP_CLOUD_TOKEN =
  process.env.WHATSAPP_CLOUD_TOKEN ||
  process.env.WHATSAPP_TOKEN ||
  '';

const SEND_WHATSAPP_CONFIRMATION =
  String(process.env.SEND_WHATSAPP_CONFIRMATION || 'false').toLowerCase() === 'true';

const LOG_RAW_WHATSAPP_EMPTY =
  String(process.env.LOG_RAW_WHATSAPP_EMPTY || 'true').toLowerCase() === 'true';

const RADAR_API_TOKEN = process.env.RADAR_API_TOKEN || '';
const RADAR_INTELLIGENCE_VERSION = 'radar_intelligence_v1_2026_06_29';

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

function requireRadarApiToken(req, res) {
  if (!RADAR_API_TOKEN) return true;

  const token =
    cleanText(req.headers['x-radar-token']) ||
    cleanText(req.headers.authorization).replace(/^Bearer\s+/i, '');

  if (token === RADAR_API_TOKEN) return true;

  res.status(401).json({
    ok: false,
    error: 'RADAR_API_TOKEN invalido ou ausente.'
  });

  return false;
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

  const cloudAudioId = cleanText(getByPath(body, 'entry[0].changes[0].value.messages[0].audio.id'));
  const cloudAudioMime = cleanText(getByPath(body, 'entry[0].changes[0].value.messages[0].audio.mime_type'));

  if (cloudAudioId) {
    return {
      media: {
        type: 'audio',
        url: '',
        id: cloudAudioId,
        mimeType: cloudAudioMime || 'audio/ogg',
        provider: 'whatsapp_cloud'
      },
      sourcePath: 'entry[0].changes[0].value.messages[0].audio.id'
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

async function callAppsScriptAction(params) {
  requireGoogleDocsApiUrl();

  const url = new URL(GOOGLE_DOCS_API_URL);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  });

  const response = await fetch(url.toString());
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
  const intelligence = await analyzeTextWithRadarIntelligence({
    text,
    from,
    profileName,
    source: source || 'render_whatsapp',
    raw
  });
  const legacyFields = buildLegacyFieldsFromRadarIntelligence(intelligence);

  return callAppsScript({
    text,
    from,
    profileName,
    source: source || 'render_whatsapp',
    origem: source || 'render_whatsapp',
    receivedAt: nowIso(),
    ...legacyFields,
    radar_intelligence: intelligence,
    structuredData: intelligence,
    raw: {
      ...(raw && typeof raw === 'object' ? raw : { value: raw }),
      radar_intelligence: intelligence
    }
  });
}

async function createVisualEntryInAppsScript({ from, profileName, originalText, mediaInfo, analysis, raw }) {
  return callAppsScript({
    action: 'create_visual_entry',
    from,
    profileName,
    originalText,
    mediaInfo,
    analysis,
    source: 'whatsapp_visual_auto',
    origem: 'whatsapp_visual_auto',
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

async function downloadWhatsappCloudMedia(media, label = 'mídia') {
  if (!media || !media.id) {
    throw new Error(`${label} da WhatsApp Cloud API sem ID.`);
  }

  if (!WHATSAPP_CLOUD_TOKEN) {
    throw new Error(`${label} da WhatsApp Cloud API exige WHATSAPP_CLOUD_TOKEN no Render.`);
  }

  const metaRes = await fetch(`https://graph.facebook.com/v19.0/${media.id}?fields=url,mime_type,file_size,sha256`, {
    headers: { Authorization: `Bearer ${WHATSAPP_CLOUD_TOKEN}` }
  });

  if (!metaRes.ok) {
    const errText = await metaRes.text();
    throw new Error(`Falha ao buscar metadados da ${label}: ${metaRes.status} — ${errText.slice(0, 500)}`);
  }

  const meta = await metaRes.json();

  if (!meta.url) {
    throw new Error(`WhatsApp Cloud não retornou URL da ${label}.`);
  }

  const fileRes = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${WHATSAPP_CLOUD_TOKEN}` }
  });

  if (!fileRes.ok) {
    const errText = await fileRes.text();
    throw new Error(`Falha ao baixar ${label}: ${fileRes.status} — ${errText.slice(0, 500)}`);
  }

  const arrayBuffer = await fileRes.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const mime = meta.mime_type || media.mimeType || fileRes.headers.get('content-type') || 'application/octet-stream';

  return { buffer, mime, meta };
}

function guessAudioFilename(mime) {
  const clean = String(mime || '').split(';')[0].trim().toLowerCase();

  if (clean.includes('mpeg') || clean.includes('mp3')) return 'whatsapp-audio.mp3';
  if (clean.includes('mp4') || clean.includes('m4a')) return 'whatsapp-audio.m4a';
  if (clean.includes('wav')) return 'whatsapp-audio.wav';
  if (clean.includes('webm')) return 'whatsapp-audio.webm';
  if (clean.includes('ogg') || clean.includes('opus')) return 'whatsapp-audio.ogg';

  return 'whatsapp-audio.ogg';
}

async function getAudioFileFromMedia(media) {
  if (!media) throw new Error('Áudio inexistente.');

  if (media.provider === 'whatsapp_cloud' && media.id) {
    const downloaded = await downloadWhatsappCloudMedia(media, 'áudio');
    return {
      buffer: downloaded.buffer,
      mime: downloaded.mime,
      filename: guessAudioFilename(downloaded.mime),
      meta: downloaded.meta
    };
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
      throw new Error(`Falha ao baixar áudio por URL: HTTP ${res.status}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    const mime = media.mimeType || res.headers.get('content-type') || 'audio/ogg';

    return {
      buffer: Buffer.from(arrayBuffer),
      mime,
      filename: guessAudioFilename(mime),
      meta: {}
    };
  }

  throw new Error('Formato de áudio não suportado para download.');
}

async function transcribeAudioWithOpenAI({ audioFile, from, profileName }) {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY não configurada no Render.');
  }

  const form = new FormData();
  const blob = new Blob([audioFile.buffer], { type: audioFile.mime || 'audio/ogg' });

  form.append('file', blob, audioFile.filename || 'whatsapp-audio.ogg');
  form.append('model', OPENAI_AUDIO_MODEL);
  form.append('language', 'pt');
  form.append(
    'prompt',
    [
      'Transcreva em português do Brasil.',
      'Preserve valores, datas, nomes, tarefas e palavras como missão ou missões.',
      from ? `Remetente: ${from}` : '',
      profileName ? `Nome: ${profileName}` : ''
    ].filter(Boolean).join('\n')
  );

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: form
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`OpenAI Audio HTTP ${response.status}: ${responseText.slice(0, 1000)}`);
  }

  let parsed;

  try {
    parsed = JSON.parse(responseText);
  } catch {
    parsed = { text: responseText };
  }

  return cleanText(parsed.text || parsed.output_text || responseText);
}

async function analyzeImageWithOpenAI({ imageDataUrl, caption, from, profileName }) {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY não configurada no Render.');
  }

  const prompt = [
    'Você é o motor visual e documental do Radar de Vida.',
    '',
    'Sua tarefa é analisar uma imagem enviada pelo WhatsApp e transformá-la em um JSON útil para um diário semântico pessoal.',
    '',
    'REGRA CENTRAL:',
    'Antes de interpretar, leia a imagem como documento. Extraia dados visíveis com precisão.',
    '',
    'ETAPA 1 — LEITURA OBJETIVA:',
    '- Identifique se a imagem é: recibo, nota fiscal, extrato, print financeiro, app de investimentos, tela bancária, comprovante, foto de objeto, foto de local, foto de atividade, comida, natureza, trabalho, manutenção ou outro.',
    '- Extraia textos visíveis relevantes.',
    '- Extraia datas visíveis.',
    '- Extraia valores monetários visíveis.',
    '- Extraia nomes de empresas, ativos, tickers, bancos, corretoras ou categorias.',
    '- Se houver linhas repetidas, leia linha por linha.',
    '',
    'ETAPA 2 — NÚMEROS:',
    '- Se a imagem mostrar dinheiro recebido, proventos, dividendos, JCP, reembolso, rendimento, salário, honorário, venda ou entrada, use dinheiro_ganho.',
    '- Se mostrar dinheiro pago, compra, despesa, boleto, débito, saída, mercado, alimentação, manutenção ou custo, use dinheiro_gasto.',
    '- Se mostrar aporte, compra de ativo, aplicação, investimento, CDB, Tesouro, FII, ação ou cripto comprado, use dinheiro_investido.',
    '- Se houver múltiplos valores positivos de recebimento, some todos em dinheiro_ganho.',
    '- Se houver múltiplos valores negativos ou pagamentos, some todos em dinheiro_gasto.',
    '- Se houver valores de investimento/aporte, some em dinheiro_investido.',
    '- Não invente valores que não estejam visíveis.',
    '- Preserve centavos com ponto decimal no JSON. Exemplo: R$ 42,25 deve virar 42.25.',
    '- Se uma linha estiver parcialmente cortada, descreva como parcial e não some valores invisíveis.',
    '',
    'ETAPA 3 — INVESTIMENTOS E PROVENTOS:',
    'Quando a imagem for de proventos, dividendos, juros sobre capital próprio, reembolso, rendimentos, B3, corretora, banco, carteira ou app financeiro:',
    '- Classifique como financeiro, investimentos, renda passiva e proventos.',
    '- Extraia cada ativo/ticker visível.',
    '- Extraia o nome da empresa quando visível.',
    '- Extraia a instituição quando visível: banco, corretora, B3, Itaú, XP, Nu, Inter etc.',
    '- Extraia o tipo de evento: dividendo, JCP, rendimento, reembolso, amortização, juros, pagamento etc.',
    '- Extraia o valor de cada evento.',
    '- Some todos os valores recebidos em dinheiro_ganho.',
    '- O insight deve mencionar renda passiva, recorrência, diversificação, concentração ou reinvestimento conforme os dados visíveis.',
    '',
    'ETAPA 4 — RECIBOS, NOTAS E COMPROVANTES:',
    'Quando a imagem for recibo, nota fiscal, tela de pagamento, comprovante ou extrato:',
    '- Identifique estabelecimento, favorecido, pagador, data, valor total e categoria provável.',
    '- Se houver total da compra, use dinheiro_gasto.',
    '- Se houver comprovante de recebimento, use dinheiro_ganho.',
    '- Se houver parcelamento, extraia número de parcelas, mas só some o valor visível pago/recebido se o contexto indicar.',
    '',
    'ETAPA 5 — TEMPO:',
    '- Só estime tempo se a imagem ou legenda indicar claramente uma atividade com duração.',
    '- Não atribua tempo produtivo, esporte ou estudo apenas porque a imagem parece importante.',
    '- Se a imagem mostrar app de exercício, smartband, treino, corrida, passos, calorias ou frequência cardíaca, extraia os números visíveis e estime tempo apenas se houver duração visível.',
    '',
    'ETAPA 6 — INTERPRETAÇÃO:',
    '- Depois dos dados objetivos, gere insight_curto e insight_profundo.',
    '- Diferencie fato de hipótese.',
    '- Seja útil, mas prudente.',
    '- Não identifique pessoas.',
    '- Não faça inferências sensíveis sobre identidade, saúde, religião, política ou intimidade.',
    '',
    'FORMATO:',
    'Responda SOMENTE com JSON válido, sem markdown.',
    '',
    'Campos obrigatórios:',
    '{',
    '  "tipo_input": "foto",',
    '  "tipo_documento_visual": "print_financeiro|recibo|nota_fiscal|extrato|comprovante|app_investimentos|app_saude|objeto|local|atividade|outro",',
    '  "descricao_visual": "descrição objetiva e curta",',
    '  "texto_lido": ["textos importantes visíveis na imagem"],',
    '  "datas_detectadas": ["datas visíveis"],',
    '  "valores_detectados": [',
    '    { "descricao": "linha ou contexto", "valor": 0, "tipo": "ganho|gasto|investimento|neutro", "confianca": "alta|media|baixa" }',
    '  ],',
    '  "itens_detectados": [',
    '    { "nome": "item, ativo, empresa ou evento", "ticker": "", "tipo_evento": "", "valor": 0, "categoria": "", "instituicao": "", "observacao": "" }',
    '  ],',
    '  "ativos_detectados": ["tickers ou ativos visíveis"],',
    '  "instituicoes_detectadas": ["bancos, corretoras, apps ou instituições visíveis"],',
    '  "metricas_detectadas": [',
    '    { "nome": "ex.: passos, calorias, km, batimentos, rendimento", "valor": 0, "unidade": "", "confianca": "alta|media|baixa" }',
    '  ],',
    '  "hipotese_de_contexto": "interpretação prudente do que isso pode representar",',
    '  "categorias": ["..."],',
    '  "projetos_detectados": ["..."],',
    '  "lugares_detectados": ["..."],',
    '  "dinheiro_gasto": 0,',
    '  "dinheiro_ganho": 0,',
    '  "dinheiro_investido": 0,',
    '  "soma_valores_positivos": 0,',
    '  "soma_valores_negativos": 0,',
    '  "tempo_estimado_minutos": 0,',
    '  "tom_emocional": "positivo|neutro|negativo|misto|indefinido",',
    '  "energia_percebida": "alta|media|baixa|exaustao|recuperacao|indefinida",',
    '  "impacto_geral": "positivo|neutro|negativo|misto|indefinido",',
    '  "dimensoes_afetadas": ["..."],',
    '  "insight_curto": "insight útil e específico baseado nos dados extraídos",',
    '  "insight_profundo": "leitura estratégica mais ampla",',
    '  "sugestao_pratica": "próxima ação simples",',
    '  "confianca": "alta|media|baixa",',
    '  "confianca_numerica": "alta|media|baixa",',
    '  "observacoes_de_leitura": "limitações da leitura, cortes, incertezas ou dados parciais",',
    '  "frase_sugerida_para_salvar": "frase em primeira pessoa resumindo o registro com números quando houver"',
    '}',
    '',
    'REGRAS DE QUALIDADE DO JSON:',
    '- Todos os campos obrigatórios devem existir.',
    '- Arrays podem ser vazios, mas devem existir.',
    '- Campos numéricos devem ser números, não strings.',
    '- Se não houver dado, use 0 para números e [] para listas.',
    '- Não use vírgula decimal. Use ponto decimal.',
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

  const analysis = parsePossiblyWrappedJson(outputText);
  return normalizeVisualAnalysisNumbers(analysis);
}

function normalizeVisualAnalysisNumbers(analysis) {
  const a = analysis || {};

  a.dinheiro_gasto = toNumber(a.dinheiro_gasto);
  a.dinheiro_ganho = toNumber(a.dinheiro_ganho);
  a.dinheiro_investido = toNumber(a.dinheiro_investido);
  a.soma_valores_positivos = toNumber(a.soma_valores_positivos);
  a.soma_valores_negativos = toNumber(a.soma_valores_negativos);
  a.tempo_estimado_minutos = toNumber(a.tempo_estimado_minutos);

  if (!Array.isArray(a.texto_lido)) a.texto_lido = [];
  if (!Array.isArray(a.datas_detectadas)) a.datas_detectadas = [];
  if (!Array.isArray(a.valores_detectados)) a.valores_detectados = [];
  if (!Array.isArray(a.itens_detectados)) a.itens_detectados = [];
  if (!Array.isArray(a.ativos_detectados)) a.ativos_detectados = [];
  if (!Array.isArray(a.instituicoes_detectadas)) a.instituicoes_detectadas = [];
  if (!Array.isArray(a.metricas_detectadas)) a.metricas_detectadas = [];
  if (!Array.isArray(a.categorias)) a.categorias = [];
  if (!Array.isArray(a.projetos_detectados)) a.projetos_detectados = [];
  if (!Array.isArray(a.lugares_detectados)) a.lugares_detectados = [];
  if (!Array.isArray(a.dimensoes_afetadas)) a.dimensoes_afetadas = [];

  a.valores_detectados = a.valores_detectados.map(item => ({
    descricao: cleanText(item.descricao),
    valor: toNumber(item.valor),
    tipo: cleanText(item.tipo) || 'neutro',
    confianca: cleanText(item.confianca) || 'media'
  }));

  a.itens_detectados = a.itens_detectados.map(item => ({
    nome: cleanText(item.nome),
    ticker: cleanText(item.ticker),
    tipo_evento: cleanText(item.tipo_evento),
    valor: toNumber(item.valor),
    categoria: cleanText(item.categoria),
    instituicao: cleanText(item.instituicao),
    observacao: cleanText(item.observacao)
  }));

  a.metricas_detectadas = a.metricas_detectadas.map(item => ({
    nome: cleanText(item.nome),
    valor: toNumber(item.valor),
    unidade: cleanText(item.unidade),
    confianca: cleanText(item.confianca) || 'media'
  }));

  return a;
}

function enhanceVisualAnalysisForAutoSave(analysis) {
  const a = analysis || {};

  const categorias = Array.isArray(a.categorias) ? [...a.categorias] : [];
  categorias.push('foto');
  categorias.push('registro visual');
  categorias.push('foto_analisada_automaticamente');

  if (
    a.tipo_documento_visual === 'print_financeiro' ||
    a.tipo_documento_visual === 'app_investimentos' ||
    /provento|dividendo|jcp|rendimento|b3|corretora|investimento/i.test(
      [
        a.descricao_visual,
        a.hipotese_de_contexto,
        ...(a.texto_lido || []),
        ...(a.categorias || [])
      ].join(' ')
    )
  ) {
    categorias.push('financeiro');
    categorias.push('investimentos');
  }

  if ((a.ativos_detectados || []).length) {
    categorias.push('ativos');
    categorias.push('carteira');
  }

  const dimensoes = Array.isArray(a.dimensoes_afetadas) ? [...a.dimensoes_afetadas] : [];
  dimensoes.push('memoria_visual');

  if (a.dinheiro_ganho > 0 || a.dinheiro_gasto > 0 || a.dinheiro_investido > 0) {
    dimensoes.push('dinheiro');
  }

  if ((a.ativos_detectados || []).length || (a.itens_detectados || []).some(i => i.ticker)) {
    dimensoes.push('investimentos');
  }

  return {
    ...a,
    categorias: Array.from(new Set(categorias.filter(Boolean).map(String))),
    dimensoes_afetadas: Array.from(new Set(dimensoes.filter(Boolean).map(String))),
    visual_auto: true,
    precisa_revisao: true,
    origem_visual: 'whatsapp_visual_auto',
    insight_curto:
      a.insight_curto ||
      'Registro visual salvo automaticamente a partir de foto enviada pelo WhatsApp.',
    frase_sugerida_para_salvar:
      a.frase_sugerida_para_salvar ||
      buildFallbackVisualPhrase(a)
  };
}

function buildFallbackVisualPhrase(a) {
  if (a.dinheiro_ganho > 0 && (a.ativos_detectados || []).length) {
    return `Recebi ${formatMoneyForText(a.dinheiro_ganho)} em proventos ou entradas financeiras relacionados a ${(a.ativos_detectados || []).join(', ')}.`;
  }

  if (a.dinheiro_ganho > 0) {
    return `Registrei uma entrada financeira de ${formatMoneyForText(a.dinheiro_ganho)} a partir de uma imagem.`;
  }

  if (a.dinheiro_gasto > 0) {
    return `Registrei uma despesa de ${formatMoneyForText(a.dinheiro_gasto)} a partir de uma imagem.`;
  }

  if (a.dinheiro_investido > 0) {
    return `Registrei um investimento de ${formatMoneyForText(a.dinheiro_investido)} a partir de uma imagem.`;
  }

  return (
    a.hipotese_de_contexto ||
    a.descricao_visual ||
    'Enviei uma foto ao Radar de Vida para registro visual automático.'
  );
}

function formatMoneyForText(value) {
  return toNumber(value).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  });
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

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  const s = String(value || '')
    .trim()
    .replace(/\s/g, '')
    .replace(/^R\$/i, '')
    .replace(/\./g, '')
    .replace(',', '.')
    .replace(/[^\d.-]/g, '');

  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function uniqueClean(values) {
  return Array.from(new Set((values || []).map(v => cleanText(v)).filter(Boolean)));
}

function isoDateOnly(value = new Date()) {
  return new Date(value).toISOString().slice(0, 10);
}

function buildRadarIntelligencePrompt({ text, from, profileName, source, receivedAt }) {
  return [
    'Voce e o motor semantico do Radar da Vida.',
    'Transforme um input solto em eventos estruturados, auditaveis e uteis para dashboard pessoal.',
    '',
    'CONTEXTO:',
    '- O Radar recebe inputs por WhatsApp, Web, API e Amazfit T-Rex 3.',
    '- O usuario quer registrar investimentos, rendimentos, refeicoes, treinos, tarefas, saude, humor, habitos e eventos importantes.',
    '- O texto bruto nunca deve ser perdido.',
    '- Nao invente dados. Diferencie fato, estimativa e inferencia.',
    '- Saude e financas sao sensiveis: nao de diagnostico medico nem recomendacao financeira definitiva.',
    '',
    'PIPELINE:',
    '1. Normalize o texto.',
    '2. Identifique se ha um ou varios eventos no mesmo input.',
    '3. Extraia campos estruturados por dominio.',
    '4. Calcule metricas estimadas quando fizer sentido, marcando como estimativa.',
    '5. Aponte campos ausentes que precisam confirmacao.',
    '6. Gere missoes/perguntas quando faltarem dados importantes.',
    '',
    'DOMINIOS:',
    '- investimentos, rendimentos, despesas, receitas',
    '- alimentacao, treino, sono, saude, humor',
    '- tarefas, estudos, trabalho, relacionamentos, habitos, ideias, reflexoes, eventos',
    '',
    'INVESTIMENTOS E RENDIMENTOS:',
    'Extraia tipo_evento, ticker, ativo, classe_ativo, quantidade, preco_unitario, valor_total, data_competencia, data_pagamento, corretora, moeda, impostos_taxas, observacoes.',
    'Tipos: compra, venda, aporte, rendimento, dividendo, jcp, aluguel_fii, cashback, resgate, taxa, imposto, rebalanceamento.',
    '',
    'ALIMENTACAO:',
    'Extraia refeicao, alimentos, porcoes_estimadas, calorias_estimadas, proteina_g, carboidratos_g, gordura_g, fibras_g, acucar_g, sodio_mg, qualidade_nutricional, contexto.',
    'Se nao houver quantidade, estime com prudencia e confidence menor.',
    '',
    'TREINO E CORPO:',
    'Extraia tipo_atividade, duracao_minutos, distancia_km, intensidade, frequencia_cardiaca, calorias_gastas_estimadas, grupos_musculares, carga, series, repeticoes, esforco_percebido, dor_lesao_fadiga.',
    '',
    'TAREFAS E MISSOES:',
    'Extraia titulo, categoria, prazo, prioridade, estado, dependencias, proxima_acao, energia_necessaria, impacto, recorrencia e projeto.',
    'Estados: ideia, aberta, em_andamento, bloqueada, concluida, cancelada.',
    '',
    'FORMATO OBRIGATORIO:',
    'Responda somente JSON valido, sem markdown.',
    '{',
    '  "version": "radar_intelligence_v1_2026_06_29",',
    '  "rawText": "texto original",',
    '  "normalizedText": "texto limpo",',
    '  "source": "origem",',
    '  "receivedAt": "ISO",',
    '  "primaryDomain": "investimentos|rendimentos|despesas|receitas|alimentacao|treino|sono|saude|humor|tarefas|estudos|trabalho|relacionamentos|habitos|ideias|reflexoes|eventos|misto|outro",',
    '  "summary": "resumo curto em primeira pessoa",',
    '  "events": [',
    '    {',
    '      "idHint": "slug curto",',
    '      "domain": "dominio",',
    '      "subtype": "subtipo",',
    '      "eventDate": "YYYY-MM-DD ou vazio",',
    '      "status": "registrado|estimado|precisa_confirmacao",',
    '      "confidence": 0.0,',
    '      "facts": {},',
    '      "estimates": {},',
    '      "metrics": {},',
    '      "missingFields": [],',
    '      "linkedEntities": [],',
    '      "tags": [],',
    '      "box": "investimentos|rendimentos|nutricao|atividade_fisica|missoes|timeline|revisao_ia"',
    '    }',
    '  ],',
    '  "lifeEvents": [',
    '    {',
    '      "ledger": "finance|nutrition|body|mission|relationship|mind|soul|timeline",',
    '      "kind": "tipo canonico do evento",',
    '      "title": "nome humano do evento",',
    '      "date": "YYYY-MM-DD ou vazio",',
    '      "status": "registered|estimated|needs_review|done|blocked|open",',
    '      "confidence": 0.0,',
    '      "metrics": {},',
    '      "entities": [],',
    '      "missingFields": [],',
    '      "sourceEventId": "idHint"',
    '    }',
    '  ],',
    '  "ledgers": {',
    '    "finance": { "events": [], "totals": {}, "quality": { "score": 0, "gaps": [] } },',
    '    "nutrition": { "events": [], "totals": {}, "quality": { "score": 0, "gaps": [] } },',
    '    "body": { "events": [], "totals": {}, "quality": { "score": 0, "gaps": [] } },',
    '    "missions": { "events": [], "totals": {}, "quality": { "score": 0, "gaps": [] } },',
    '    "relationships": { "events": [], "totals": {}, "quality": { "score": 0, "gaps": [] } },',
    '    "mindSoul": { "events": [], "totals": {}, "quality": { "score": 0, "gaps": [] } }',
    '  },',
    '  "totals": {',
    '    "moneyEarned": 0,',
    '    "moneySpent": 0,',
    '    "moneyInvested": 0,',
    '    "passiveIncome": 0,',
    '    "caloriesIn": 0,',
    '    "caloriesOut": 0,',
    '    "proteinG": 0,',
    '    "carbsG": 0,',
    '    "fatG": 0,',
    '    "fiberG": 0,',
    '    "activityMinutes": 0',
    '  },',
    '  "dashboard": {',
    '    "boxes": [],',
    '    "chartHints": [],',
    '    "reviewRequired": false',
    '  },',
    '  "missions": [',
    '    { "title": "", "reason": "", "priority": "baixa|media|alta", "dueHint": "", "status": "aberta" }',
    '  ],',
    '  "questions": [],',
    '  "confidence": 0.0',
    '}',
    '',
    'REGRAS:',
    '- Campos numericos devem ser numeros.',
    '- Use arrays vazios quando nao houver dado.',
    '- Inclua confidence por evento.',
    '- Sempre preencha lifeEvents a partir dos events. lifeEvents e ledgers sao a camada canonica para graficos futuros.',
    '- Um mesmo input pode gerar mais de um lifeEvent; por exemplo jantar com a mae = nutrition + relationship + finance se houver gasto.',
    '- Se houver ticker sem valor, registre ticker e marque campo ausente.',
    '- Se houver comida sem porcao, estime nutrientes de forma conservadora e marque porcao como ausente.',
    '- Se faltarem dados corporais do usuario para meta nutricional, crie missao para coletar peso, altura, idade, sexo, objetivo e nivel de atividade.',
    '',
    `Texto: ${text}`,
    `Origem: ${source || 'desconhecida'}`,
    from ? `Remetente: ${from}` : '',
    profileName ? `Nome: ${profileName}` : '',
    `Recebido em: ${receivedAt || nowIso()}`
  ].filter(Boolean).join('\n');
}

async function analyzeTextWithRadarIntelligence({ text, from, profileName, source, raw }) {
  const receivedAt = nowIso();

  if (!OPENAI_API_KEY) {
    const fallback = buildLocalRadarIntelligence({ text, from, profileName, source, raw, receivedAt });
    fallback.engine = 'local_fallback_no_openai_key';
    fallback.model = 'offline';
    fallback.error = 'OPENAI_API_KEY ausente no ambiente do servidor';
    return fallback;
  }

  const prompt = buildRadarIntelligencePrompt({ text, from, profileName, source, receivedAt });

  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: OPENAI_TEXT_MODEL,
        input: prompt,
        temperature: 0.1
      })
    });

    const body = await response.text();

    if (!response.ok) {
      throw new Error(`OpenAI Text HTTP ${response.status}: ${body.slice(0, 1000)}`);
    }

    const parsed = JSON.parse(body);
    const outputText = extractOpenAIText(parsed);
    const intelligence = normalizeRadarIntelligence(parsePossiblyWrappedJson(outputText), {
      text,
      source,
      receivedAt
    });

    intelligence.engine = 'openai_responses';
    intelligence.model = OPENAI_TEXT_MODEL;

    return intelligence;
  } catch (err) {
    console.warn('[RADAR_INTELLIGENCE] Falha na IA textual; usando heuristica local:', err.message);
    const fallback = buildLocalRadarIntelligence({ text, from, profileName, source, raw, receivedAt });
    fallback.engine = 'local_fallback_after_openai_error';
    fallback.error = err.message;
    return fallback;
  }
}

function normalizeRadarIntelligence(intelligence, { text, source, receivedAt }) {
  const normalizedText = normalizeWhitespace(intelligence.normalizedText || text);
  const events = Array.isArray(intelligence.events) ? intelligence.events : [];
  const totals = intelligence.totals || {};

  const cleanEvents = events.map((event, index) => ({
    idHint: cleanText(event.idHint) || `event_${index + 1}`,
    domain: cleanText(event.domain) || 'outro',
    subtype: cleanText(event.subtype),
    eventDate: cleanText(event.eventDate),
    status: cleanText(event.status) || 'registrado',
    confidence: Math.max(0, Math.min(1, Number(event.confidence) || 0.5)),
    facts: event.facts && typeof event.facts === 'object' ? event.facts : {},
    estimates: event.estimates && typeof event.estimates === 'object' ? event.estimates : {},
    metrics: event.metrics && typeof event.metrics === 'object' ? event.metrics : {},
    missingFields: uniqueClean(event.missingFields || []),
    linkedEntities: uniqueClean(event.linkedEntities || []),
    tags: uniqueClean(event.tags || []),
    box: cleanText(event.box) || inferBoxFromDomain(event.domain)
  }));
  const cleanLifeEvents = normalizeLifeEvents(intelligence.lifeEvents, cleanEvents);
  const ledgers = buildLifeLedgers(cleanLifeEvents);

  return {
    version: RADAR_INTELLIGENCE_VERSION,
    rawText: String(text || ''),
    normalizedText,
    source: cleanText(intelligence.source) || source || 'render_whatsapp',
    receivedAt: cleanText(intelligence.receivedAt) || receivedAt || nowIso(),
    primaryDomain: cleanText(intelligence.primaryDomain) || inferPrimaryDomain(cleanEvents),
    summary: cleanText(intelligence.summary) || normalizedText,
    events: cleanEvents,
    lifeEvents: cleanLifeEvents,
    ledgers,
    totals: {
      moneyEarned: toNumber(totals.moneyEarned),
      moneySpent: toNumber(totals.moneySpent),
      moneyInvested: toNumber(totals.moneyInvested),
      passiveIncome: toNumber(totals.passiveIncome),
      caloriesIn: toNumber(totals.caloriesIn),
      caloriesOut: toNumber(totals.caloriesOut),
      proteinG: toNumber(totals.proteinG),
      carbsG: toNumber(totals.carbsG),
      fatG: toNumber(totals.fatG),
      fiberG: toNumber(totals.fiberG),
      activityMinutes: toNumber(totals.activityMinutes)
    },
    dashboard: {
      boxes: uniqueClean(intelligence.dashboard?.boxes || cleanEvents.map(e => e.box)),
      chartHints: uniqueClean(intelligence.dashboard?.chartHints || []),
      reviewRequired: Boolean(intelligence.dashboard?.reviewRequired || cleanEvents.some(e => e.missingFields.length))
    },
    missions: Array.isArray(intelligence.missions) ? intelligence.missions.map(mission => ({
      title: cleanText(mission.title),
      reason: cleanText(mission.reason),
      priority: cleanText(mission.priority) || 'media',
      dueHint: cleanText(mission.dueHint),
      status: cleanText(mission.status) || 'aberta'
    })).filter(mission => mission.title) : [],
    questions: uniqueClean(intelligence.questions || []),
    confidence: Math.max(0, Math.min(1, Number(intelligence.confidence) || average(cleanEvents.map(e => e.confidence)) || 0.5))
  };
}

function normalizeLifeEvents(inputLifeEvents, events) {
  const provided = Array.isArray(inputLifeEvents) ? inputLifeEvents : [];
  const normalizedProvided = provided.map((event, index) => normalizeLifeEvent(event, `provided_${index + 1}`));
  const derived = events.flatMap(eventToLifeEvents);
  const merged = [...normalizedProvided, ...derived].filter(Boolean);
  const seen = new Set();

  return merged.filter(event => {
    const key = [
      event.ledger,
      event.kind,
      event.title,
      event.date,
      JSON.stringify(event.metrics || {})
    ].join('|').toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeLifeEvent(event, fallbackId) {
  if (!event || typeof event !== 'object') return null;
  const ledger = canonicalLedger(event.ledger || event.domain || event.box);
  const confidence = Math.max(0, Math.min(1, Number(event.confidence) || 0.5));

  return {
    id: cleanText(event.id) || fallbackId,
    ledger,
    kind: cleanText(event.kind || event.subtype || event.type) || 'registro',
    title: cleanText(event.title || event.summary || event.idHint) || 'Registro de vida',
    date: cleanText(event.date || event.eventDate),
    status: canonicalLifeStatus(event.status),
    confidence,
    metrics: event.metrics && typeof event.metrics === 'object' ? normalizeMetricObject(event.metrics) : {},
    entities: uniqueClean(event.entities || event.linkedEntities || []),
    missingFields: uniqueClean(event.missingFields || []),
    sourceEventId: cleanText(event.sourceEventId || event.idHint)
  };
}

function eventToLifeEvents(event) {
  const domain = cleanText(event.domain).toLowerCase();
  const box = cleanText(event.box).toLowerCase();
  const facts = event.facts || {};
  const metrics = event.metrics || {};
  const title = cleanText(facts.titulo || facts.descricao_refeicao || event.subtype || event.domain) || 'Registro de vida';
  const common = {
    title,
    date: event.eventDate,
    status: event.status,
    confidence: event.confidence,
    entities: event.linkedEntities || [],
    missingFields: event.missingFields || [],
    sourceEventId: event.idHint
  };
  const out = [];

  if (/invest|rend|receita|despesa|finance/.test(domain) || /invest|rend/.test(box) || toNumber(metrics.moneySpent) || toNumber(metrics.moneyEarned) || toNumber(metrics.moneyInvested) || toNumber(metrics.passiveIncome)) {
    out.push(normalizeLifeEvent({
      ...common,
      ledger: 'finance',
      kind: event.subtype || 'movimento_financeiro',
      metrics: {
        moneySpent: metrics.moneySpent,
        moneyEarned: metrics.moneyEarned,
        moneyInvested: metrics.moneyInvested,
        passiveIncome: metrics.passiveIncome,
        quantity: facts.quantidade,
        unitPrice: facts.preco_unitario,
        totalValue: facts.valor_total
      }
    }, `${event.idHint || 'finance'}_life`));
  }

  if (/aliment|nutri|refei|comida/.test(domain) || /nutri/.test(box) || toNumber(metrics.caloriesIn) || toNumber(metrics.proteinG)) {
    out.push(normalizeLifeEvent({
      ...common,
      ledger: 'nutrition',
      kind: event.subtype || 'refeicao',
      metrics: {
        caloriesIn: metrics.caloriesIn,
        proteinG: metrics.proteinG,
        carbsG: metrics.carbsG,
        fatG: metrics.fatG,
        fiberG: metrics.fiberG
      }
    }, `${event.idHint || 'nutrition'}_life`));
  }

  if (/treino|atividade|sono|saude|corpo/.test(domain) || /atividade/.test(box) || toNumber(metrics.activityMinutes) || toNumber(metrics.caloriesOut)) {
    out.push(normalizeLifeEvent({
      ...common,
      ledger: 'body',
      kind: event.subtype || 'atividade',
      metrics: {
        activityMinutes: metrics.activityMinutes,
        caloriesOut: metrics.caloriesOut,
        distanceKm: facts.distancia_km,
        heartRate: facts.frequencia_cardiaca
      }
    }, `${event.idHint || 'body'}_life`));
  }

  if (/tarefa|miss|trabalho|estudo/.test(domain) || /miss/.test(box)) {
    out.push(normalizeLifeEvent({
      ...common,
      ledger: 'mission',
      kind: event.subtype || 'missao',
      metrics: {
        progress: facts.progresso,
        priorityWeight: priorityToWeight(facts.prioridade || event.tags?.join(' '))
      }
    }, `${event.idHint || 'mission'}_life`));
  }

  if (/relac|social|familia|amigo|mae|pai|encontro/.test(domain) || /relac|social/.test(box)) {
    out.push(normalizeLifeEvent({
      ...common,
      ledger: 'relationship',
      kind: event.subtype || 'interacao_social',
      metrics: {
        relationalValue: 1
      }
    }, `${event.idHint || 'relationship'}_life`));
  }

  if (!out.length) {
    out.push(normalizeLifeEvent({
      ...common,
      ledger: /humor|reflex|ideia|alma|espiritual|mente/.test(domain) ? 'mind' : 'timeline',
      kind: event.subtype || 'registro_textual',
      metrics: {}
    }, `${event.idHint || 'timeline'}_life`));
  }

  return out.filter(Boolean);
}

function canonicalLedger(value) {
  const v = cleanText(value).toLowerCase();
  if (/financ|invest|rend|money|receita|despesa/.test(v)) return 'finance';
  if (/nutri|aliment|refei|food/.test(v)) return 'nutrition';
  if (/body|corpo|treino|atividade|sono|saude/.test(v)) return 'body';
  if (/mission|miss|tarefa|todo|trabalho|estudo/.test(v)) return 'mission';
  if (/relac|social|famil|pessoa|contact/.test(v)) return 'relationship';
  if (/mind|mente|alma|soul|humor|reflex|ideia/.test(v)) return 'mind';
  return 'timeline';
}

function canonicalLifeStatus(status) {
  const s = cleanText(status).toLowerCase();
  if (/conclu|done|final/.test(s)) return 'done';
  if (/bloque|block/.test(s)) return 'blocked';
  if (/estim/.test(s)) return 'estimated';
  if (/confirm|review|revis/.test(s)) return 'needs_review';
  if (/abert|open|andamento/.test(s)) return 'open';
  return 'registered';
}

function normalizeMetricObject(metrics) {
  return Object.fromEntries(Object.entries(metrics || {}).map(([key, value]) => [key, toNumber(value)]));
}

function priorityToWeight(value) {
  const v = cleanText(value).toLowerCase();
  if (/alta|high|urgente/.test(v)) return 2;
  if (/baixa|low/.test(v)) return 0.5;
  return 1;
}

function buildLifeLedgers(lifeEvents) {
  const ledgers = {
    finance: emptyLedger(),
    nutrition: emptyLedger(),
    body: emptyLedger(),
    missions: emptyLedger(),
    relationships: emptyLedger(),
    mindSoul: emptyLedger(),
    timeline: emptyLedger()
  };

  (lifeEvents || []).forEach(event => {
    const key = event.ledger === 'mission'
      ? 'missions'
      : event.ledger === 'relationship'
        ? 'relationships'
        : event.ledger === 'mind'
          ? 'mindSoul'
          : event.ledger;
    const ledger = ledgers[key] || ledgers.timeline;
    ledger.events.push(event);
    Object.entries(event.metrics || {}).forEach(([metric, value]) => {
      ledger.totals[metric] = toNumber(ledger.totals[metric]) + toNumber(value);
    });
    event.missingFields.forEach(field => {
      if (!ledger.quality.gaps.includes(field)) ledger.quality.gaps.push(field);
    });
  });

  Object.values(ledgers).forEach(ledger => {
    const confidence = average(ledger.events.map(event => event.confidence));
    const gapPenalty = Math.min(45, ledger.quality.gaps.length * 8);
    ledger.quality.score = Math.max(0, Math.round((confidence || 0) * 100 - gapPenalty));
  });

  return ledgers;
}

function emptyLedger() {
  return {
    events: [],
    totals: {},
    quality: {
      score: 0,
      gaps: []
    }
  };
}

function inferBoxFromDomain(domain) {
  const d = cleanText(domain).toLowerCase();
  if (/rend|dividendo|provento|jcp/.test(d)) return 'rendimentos';
  if (/invest/.test(d)) return 'investimentos';
  if (/aliment|nutri|comida|refei/.test(d)) return 'nutricao';
  if (/treino|atividade|sono|saude/.test(d)) return 'atividade_fisica';
  if (/tarefa|miss|trabalho|estudo/.test(d)) return 'missoes';
  return 'timeline';
}

function inferPrimaryDomain(events) {
  const domains = events.map(e => e.domain).filter(Boolean);
  if (!domains.length) return 'outro';
  return uniqueClean(domains).length > 1 ? 'misto' : domains[0];
}

function average(values) {
  const nums = (values || []).map(Number).filter(Number.isFinite);
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function extractMoneyMentions(text) {
  const mentions = [];
  const regex = /(?:r\$\s*)?(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{1,2}))?\s*(?:reais|real|brl|r\$)?/gi;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const raw = match[0];
    if (!/[r$]|reais|real|brl/i.test(raw)) continue;
    mentions.push(toNumber(raw));
  }

  return mentions.filter(n => n > 0);
}

function extractTickers(text) {
  return uniqueClean(String(text || '').match(/\b[A-Z]{4}\d{1,2}\b/g) || []);
}

function extractInvestmentTrade(text, tickers, moneyMentions) {
  const s = String(text || '');
  const firstTicker = tickers[0] || '';
  const quantityMatch = firstTicker
    ? s.match(new RegExp(`(\\d+(?:[,.]\\d+)?)\\s*(?:a[cç][oõ]es|acoes|cotas|unidades)?\\s*(?:de\\s+)?${firstTicker}`, 'i'))
    : null;
  const priceMatch = s.match(/\b(?:a|por|preco|pre[cç]o)\s*(?:r\$\s*)?(\d+(?:[,.]\d+)?)/i);
  const quantity = quantityMatch ? toNumber(quantityMatch[1]) : 0;
  const unitPrice = priceMatch ? toNumber(priceMatch[1]) : 0;
  const total = quantity && unitPrice ? quantity * unitPrice : (moneyMentions[0] || 0);

  return {
    quantity,
    unitPrice,
    total
  };
}

function extractDurationMinutes(text) {
  const s = String(text || '').toLowerCase();
  let total = 0;
  const regex = /(\d+(?:[,.]\d+)?)\s*(h|hora|horas|min|minuto|minutos)\b/g;
  let match;

  while ((match = regex.exec(s)) !== null) {
    const value = parseFloat(String(match[1]).replace(',', '.')) || 0;
    total += /^h|hora/.test(match[2]) ? value * 60 : value;
  }

  return Math.round(total);
}

function buildLocalRadarIntelligence({ text, source, receivedAt }) {
  const rawText = String(text || '');
  const normalizedText = normalizeWhitespace(rawText);
  const lower = normalizedText.toLowerCase();
  const events = [];
  const money = extractMoneyMentions(normalizedText);
  const tickers = extractTickers(normalizedText);
  const durationMinutes = extractDurationMinutes(normalizedText);

  const hasInvestment =
    tickers.length ||
    /\b(comprei|vendi|aportei|apliquei|investi|dividendo|dividendos|jcp|rendimento|rendimentos|provento|proventos|fii|a[cç][aã]o|acoes|tesouro|cdb|etf|cripto)\b/i.test(normalizedText);

  const hasFood =
    /\b(cafe|caf[eé]|almoc|almo[cç]o|jantar|jantei|lanche|comi|bebi|arroz|feij[aã]o|frango|carne|ovo|salada|hamburg|pizza|prote[ií]na|whey|banana|p[aã]o)\b/i.test(normalizedText);

  const hasActivity =
    /\b(corri|corrida|caminhei|caminhada|treinei|treino|academia|muscula[cç][aã]o|pedalei|bike|futebol|alonguei|alongamento|passos|km)\b/i.test(normalizedText);

  const hasTask =
    /\b(preciso|devo|tenho que|tarefa|miss[aã]o|missao|prazo|pagar|resolver|comprar|ligar|enviar|fazer|concluir|bloqueado|andamento)\b/i.test(normalizedText);

  if (hasInvestment) {
    const trade = extractInvestmentTrade(normalizedText, tickers, money);
    const subtype = /\b(recebi|ganhei|dividendo|dividendos|jcp|rendimento|rendimentos|provento|proventos)\b/i.test(normalizedText)
      ? 'rendimento'
      : /\bvendi|venda\b/i.test(normalizedText)
        ? 'venda'
        : /\b(comprei|compra|aportei|apliquei|investi)\b/i.test(normalizedText)
          ? 'compra_aporte'
          : 'investimento';
    const value = trade.total || 0;
    events.push({
      idHint: 'investimentos',
      domain: subtype === 'rendimento' ? 'rendimentos' : 'investimentos',
      subtype,
      eventDate: /\bhoje\b/i.test(normalizedText) ? isoDateOnly() : '',
      status: tickers.length && value ? 'registrado' : 'precisa_confirmacao',
      confidence: tickers.length || value ? 0.72 : 0.45,
      facts: {
        tickers,
        quantidade: trade.quantity,
        preco_unitario: trade.unitPrice,
        valor_total: value,
        moeda: 'BRL',
        tipo_evento: subtype
      },
      estimates: {},
      metrics: {
        passiveIncome: subtype === 'rendimento' ? value : 0,
        moneyInvested: subtype === 'compra_aporte' ? value : 0,
        moneyEarned: subtype === 'rendimento' || subtype === 'venda' ? value : 0
      },
      missingFields: [
        tickers.length ? '' : 'ticker',
        value ? '' : 'valor_total',
        'data_competencia'
      ].filter(Boolean),
      linkedEntities: tickers,
      tags: uniqueClean(['financeiro', 'investimentos', subtype, ...tickers]),
      box: subtype === 'rendimento' ? 'rendimentos' : 'investimentos'
    });
  }

  if (hasFood) {
    const calorieGuess = /\b(hamburg|pizza|lanche)/i.test(normalizedText) ? 700 : /\b(arroz|feij|frango|salada)/i.test(normalizedText) ? 650 : 350;
    events.push({
      idHint: 'alimentacao',
      domain: 'alimentacao',
      subtype: /\bjantar|jantei\b/i.test(lower) ? 'jantar' : /\balmoc|almo[cç]o\b/i.test(lower) ? 'almoco' : /\bcafe|caf[eé]\b/i.test(lower) ? 'cafe_da_manha' : 'refeicao',
      eventDate: /\bhoje\b/i.test(normalizedText) ? isoDateOnly() : '',
      status: 'estimado',
      confidence: 0.55,
      facts: {
        descricao_refeicao: normalizedText
      },
      estimates: {
        calorias_estimadas: calorieGuess,
        proteina_g: Math.round(calorieGuess * 0.06),
        carboidratos_g: Math.round(calorieGuess * 0.12),
        gordura_g: Math.round(calorieGuess * 0.035)
      },
      metrics: {
        caloriesIn: calorieGuess,
        proteinG: Math.round(calorieGuess * 0.06),
        carbsG: Math.round(calorieGuess * 0.12),
        fatG: Math.round(calorieGuess * 0.035)
      },
      missingFields: ['porcao', 'peso_altura_idade_objetivo_para_meta_nutricional'],
      linkedEntities: [],
      tags: ['alimentacao', 'nutricao', 'refeicao'],
      box: 'nutricao'
    });
  }

  if (hasActivity) {
    events.push({
      idHint: 'atividade_fisica',
      domain: 'treino',
      subtype: /\bcaminh/.test(lower) ? 'caminhada' : /\bcorr/.test(lower) ? 'corrida' : /\btrein|academ|muscula/.test(lower) ? 'treino' : 'atividade',
      eventDate: /\bhoje\b/i.test(normalizedText) ? isoDateOnly() : '',
      status: durationMinutes ? 'registrado' : 'precisa_confirmacao',
      confidence: durationMinutes ? 0.75 : 0.55,
      facts: {
        duracao_minutos: durationMinutes
      },
      estimates: {
        calorias_gastas_estimadas: durationMinutes ? Math.round(durationMinutes * 6) : 0
      },
      metrics: {
        activityMinutes: durationMinutes,
        caloriesOut: durationMinutes ? Math.round(durationMinutes * 6) : 0
      },
      missingFields: durationMinutes ? [] : ['duracao_minutos'],
      linkedEntities: [],
      tags: ['corpo', 'atividade_fisica'],
      box: 'atividade_fisica'
    });
  }

  if (hasTask) {
    events.push({
      idHint: 'missao_tarefa',
      domain: 'tarefas',
      subtype: /\bmiss/.test(lower) ? 'missao' : 'tarefa',
      eventDate: /\bhoje\b/i.test(normalizedText) ? isoDateOnly() : '',
      status: /\bconclu/.test(lower) ? 'concluida' : /\bbloque/.test(lower) ? 'bloqueada' : 'aberta',
      confidence: 0.6,
      facts: {
        titulo: normalizedText,
        prazo: /\bamanh/.test(lower) ? 'amanha' : /\bhoje\b/.test(lower) ? 'hoje' : ''
      },
      estimates: {},
      metrics: {},
      missingFields: /\bamanh|hoje\b/.test(lower) ? [] : ['prazo'],
      linkedEntities: [],
      tags: ['missao', 'tarefa'],
      box: 'missoes'
    });
  }

  if (!events.length) {
    events.push({
      idHint: 'timeline',
      domain: 'eventos',
      subtype: 'registro_textual',
      eventDate: /\bhoje\b/i.test(normalizedText) ? isoDateOnly() : '',
      status: 'registrado',
      confidence: 0.4,
      facts: { texto: normalizedText },
      estimates: {},
      metrics: {},
      missingFields: [],
      linkedEntities: [],
      tags: ['timeline'],
      box: 'timeline'
    });
  }

  const totals = events.reduce((acc, event) => {
    Object.entries(event.metrics || {}).forEach(([key, value]) => {
      acc[key] = toNumber(acc[key]) + toNumber(value);
    });
    return acc;
  }, {});

  return normalizeRadarIntelligence({
    version: RADAR_INTELLIGENCE_VERSION,
    rawText,
    normalizedText,
    source: source || 'render_whatsapp',
    receivedAt,
    primaryDomain: events.length > 1 ? 'misto' : events[0].domain,
    summary: normalizedText,
    events,
    totals,
    dashboard: {
      boxes: uniqueClean(events.map(e => e.box)),
      chartHints: uniqueClean(events.map(e => e.domain)),
      reviewRequired: events.some(e => (e.missingFields || []).length)
    },
    missions: events.some(e => e.domain === 'alimentacao' && (e.missingFields || []).includes('peso_altura_idade_objetivo_para_meta_nutricional'))
      ? [{
          title: 'Completar perfil corporal para metas de nutricao',
          reason: 'Calorias e macros ficam melhores com peso, altura, idade, sexo, objetivo e nivel de atividade.',
          priority: 'media',
          dueHint: 'quando possivel',
          status: 'aberta'
        }]
      : [],
    questions: uniqueClean(events.flatMap(e => e.missingFields || []).map(field => `Confirmar ${field}`)),
    confidence: average(events.map(e => e.confidence))
  }, { text: rawText, source, receivedAt });
}

function buildLegacyFieldsFromRadarIntelligence(intelligence) {
  const events = intelligence.events || [];
  const categories = uniqueClean([
    intelligence.primaryDomain,
    ...(intelligence.dashboard?.boxes || []),
    ...events.flatMap(e => e.tags || []),
    ...events.map(e => e.domain),
    ...events.map(e => e.subtype)
  ]);
  const linked = uniqueClean(events.flatMap(e => e.linkedEntities || []));

  return {
    radar_intelligence_version: intelligence.version,
    radar_primary_domain: intelligence.primaryDomain,
    radar_summary: intelligence.summary,
    radar_structured_events_count: events.length,
    radar_life_events_count: intelligence.lifeEvents?.length || 0,
    radar_ledger_quality: Object.fromEntries(Object.entries(intelligence.ledgers || {}).map(([key, ledger]) => [key, ledger.quality?.score || 0])),
    radar_review_required: Boolean(intelligence.dashboard?.reviewRequired),
    radar_boxes: intelligence.dashboard?.boxes || [],
    categorias_sugeridas: categories,
    ativos_detectados: linked.filter(v => /^[A-Z]{4}\d{1,2}$/.test(v)),
    dinheiro_ganho_sugerido: intelligence.totals.moneyEarned,
    dinheiro_gasto_sugerido: intelligence.totals.moneySpent,
    dinheiro_investido_sugerido: intelligence.totals.moneyInvested,
    calorias_ingeridas_sugeridas: intelligence.totals.caloriesIn,
    calorias_gastas_sugeridas: intelligence.totals.caloriesOut,
    proteina_g_sugerida: intelligence.totals.proteinG,
    atividade_fisica_minutos_sugerida: intelligence.totals.activityMinutes
  };
}

function buildPersonalRadarPrompt({ entries, periodLabel, profileName }) {
  return [
    'Voce e o GPT interno do Radar da Vida.',
    'Atue como uma inteligencia de organizacao existencial, financeira, corporal, nutricional, produtiva e narrativa.',
    'Seu trabalho nao e apenas classificar dados: e transformar microeventos da vida real em memoria operavel, autoconsciencia, graficos uteis e proximas acoes.',
    '',
    'FILOSOFIA DO RADAR DA VIDA',
    '- A vida e composta por entradas pequenas: frases, gastos, rendimentos, comida, treino, tarefas, imagens, emocoes, deslocamentos e decisoes.',
    '- Cada entrada deve virar um evento compreensivel, com dominio, data, valor, intensidade, impacto, incerteza e destino no painel.',
    '- O sistema deve respeitar a linguagem natural do usuario: ele pode falar de modo baguncado, poetico, incompleto, ansioso, objetivo ou misturando varios assuntos.',
    '- O app nao deve punir frases incompletas; deve preservar o que sabe, estimar com humildade e apontar o que falta.',
    '- O objetivo e aumentar fidelidade de registro, nao criar uma narrativa falsa.',
    '- O Radar deve enxergar ativos invisiveis: saude, energia, disciplina, aprendizado, capital financeiro, relacoes, reputacao, organizacao, descanso e paz mental.',
    '- O Radar deve enxergar passivos invisiveis: atrito, vazamento de dinheiro, excesso de tarefa aberta, sono ruim, comida pobre, sedentarismo, ansiedade, desorganizacao e promessas nao fechadas.',
    '- Uma vida plena nao e apenas produtividade. Ela envolve corpo com energia, mente clara, alma em paz, vinculos reais, beleza, gratidao, contribuicao, liberdade, seguranca material, aventura, descanso e sentido.',
    '- O app deve procurar sinais de felicidade sustentavel: sono reparador, alimentacao que nutre, movimento fisico, intimidade social, tempo na natureza, aprendizado, trabalho com significado, prazer simples, espiritualidade ou contemplação, generosidade e autonomia.',
    '- O app tambem deve procurar sinais de empobrecimento da vida: isolamento, pressa cronica, excesso de tela, comida sem nutricao, ausencia de movimento, dinheiro sem proposito, tarefas sem fechamento, sono desalinhado, consumo compensatorio e falta de rito.',
    '- Interprete a vida como ecossistema: uma refeicao afeta energia; sono afeta humor; dinheiro afeta liberdade; relacoes afetam alma; ambiente afeta foco; missao afeta coragem.',
    '- Seja inclusivo: respeite diferentes formas de viver bem. Nao imponha moralismo, dieta rigida, espiritualidade especifica, padrao social unico ou produtividade vazia.',
    '- Seja profundo sem ser dramatico. Gere insights preciosos, praticos e humanos, com linguagem clara, gentil e acionavel.',
    '',
    'DOMINIOS PRINCIPAIS',
    '1. investimentos: compras, vendas, aportes, tickers, quantidade, preco medio, classe de ativo, corretora se aparecer, tese, risco, data de operacao.',
    '2. rendimentos: dividendos, JCP, proventos, aluguel, juros, cupons, rendimento de FII, valor recebido, ticker, competencia, data de pagamento.',
    '3. alimentacao: refeicoes, alimentos, bebidas, horario, estimativa de calorias, proteina, carboidrato, gordura, fibra, qualidade nutricional, saciedade.',
    '4. atividade_fisica: treino, caminhada, corrida, musculacao, passos, duracao, intensidade, calorias gastas, zona de esforco, recuperacao.',
    '5. corpo_saude: peso, sono, dor, energia, humor fisico, exames, medicamentos, sinais corporais, hidratacao.',
    '6. missoes_tarefas: tarefas abertas, progresso, status, bloqueios, prazo, responsavel, prioridade, proxima acao, criterio de conclusao.',
    '7. trabalho_projetos: trabalho juridico, clientes, Codex, Radar, projetos, estudo, producao, reunioes, entregas, alavancagem.',
    '8. financeiro_pessoal: gastos, ganhos, contas, boletos, dividas, recorrencias, vazamentos, compras necessarias, compras impulsivas.',
    '9. relacoes: familia, amigos, clientes, conversas, conflitos, presenca, cuidado, acordos, promessas.',
    '10. casa_ambiente: sitio, casa, manutencao, objetos, organizacao fisica, compras domesticas, energia solar, estrutura.',
    '11. emocional_sentido: medo, alegria, orgulho, cansaco, ansiedade, gratidao, luto, entusiasmo, significado e tom existencial.',
    '12. memoria_visual_documental: fotos, prints, documentos, comprovantes, imagens que servem como evidencia.',
    '13. mente_aprendizado: leitura, estudo, estrategia, criatividade, tomada de decisao, clareza, foco, curiosidade.',
    '14. alma_sentido: fe, contemplacao, gratidao, beleza, natureza, silencio, valores, coerencia, paz, esperanca.',
    '15. vida_social_comunidade: familia, amizade, amor, cuidado, pertencimento, conversas, reciprocidade, conflitos e reparos.',
    '16. lazer_alegria: prazer legitimo, celebracao, descanso, humor, musica, viagem, comida social, experiencias memoraveis.',
    '17. ambiente_rituais: casa, sitio, ordem, luz, objetos, manutencao, ritos diarios, rotina, friccao do espaco.',
    '',
    'REGRAS DE INTERPRETACAO',
    '- Uma frase pode gerar multiplos eventos. Ex.: "recebi 42 de MXRF11, almocei frango e corri 30 minutos" deve virar rendimento, alimentacao e atividade_fisica.',
    '- Preserve todo numero explicitado. Nunca descarte valor, ticker, quantidade, minutos, km, horario ou data.',
    '- Se houver dinheiro sem contexto, classifique como financeiro_pessoal e marque missingFields.',
    '- Se houver ticker com verbo "recebi", "caiu", "pagou", "dividendo", classifique como rendimento, nao como compra.',
    '- Se houver ticker com "comprei", "aportei", "vendi", classifique como investimento.',
    '- Para comida, estime calorias e macros com cautela. Informe que e estimativa quando nao houver quantidade.',
    '- Para treino, estime intensidade por verbo e contexto. Caminhada leve, corrida moderada, musculacao variavel.',
    '- Para tarefa, identifique status: aberta, em_andamento, bloqueada, concluida, cancelada, aguardando.',
    '- Para projetos e missoes, gere proxima acao concreta, pequena e verificavel.',
    '- Para entradas emocionais, nao medicalize. Transforme em leitura de estado e necessidade pratica.',
    '- Para vida social, diferencie gasto social de investimento relacional. Um jantar com a mae pode ser despesa financeira e ativo afetivo.',
    '- Para corpo, considere o triangulo sono + comida + movimento. Se um deles falta, sugira registro complementar.',
    '- Para mente, observe foco, aprendizado, carga cognitiva, decisao e criatividade.',
    '- Para alma/sentido, observe paz, gratidao, beleza, natureza, espiritualidade, desalinhamento e necessidade de silencio.',
    '- Para felicidade, procure equilibrio entre prazer imediato, saude futura, relacoes e sentido.',
    '- Para dinheiro, nao reduza tudo a gastar menos: avalie se o gasto comprou nutricao, cuidado, amor, paz, ferramenta, tempo ou so alivio momentaneo.',
    '- Para missao, transforme desejos vagos em proximas acoes pequenas. Uma boa proxima acao deve caber em 15 a 45 minutos.',
    '- Para qualquer incerteza, use confidence menor e liste perguntas objetivas.',
    '',
    'GRAFICOS IDEAIS A SUGERIR',
    '- Renda passiva por ticker e por mes.',
    '- Aportes por ativo, classe e data.',
    '- Fluxo de capital: gasto, ganho, aporte, rendimento.',
    '- Calorias ingeridas x calorias gastas x proteina.',
    '- Consistencia corporal: dias com atividade, minutos, intensidade.',
    '- Mapa de missoes por status, prazo e bloqueio.',
    '- Divida de revisao: campos ausentes por dominio.',
    '- Ativos invisiveis x passivos invisiveis.',
    '- Horario narrativo: quando a vida e mais registrada.',
    '- Energia do dia: alimentacao, treino, sono e humor.',
    '- Vida plena: corpo, mente, alma, social, trabalho e financeiro.',
    '- Alegria sustentavel: prazer, descanso, vinculos e sentido.',
    '- Ativos afetivos: momentos com familia, amigos, cuidado e pertencimento.',
    '- Ritos e friccao: horarios, sono, ambiente, recorrencias e manutencao.',
    '',
    'SAIDA OBRIGATORIA',
    'Responda apenas JSON valido. Sem markdown. Sem texto fora do JSON.',
    'Formato: { "summary": "...", "dominantPatterns": [], "events": [], "totals": {}, "lifeDimensions": {}, "wellbeing": {}, "charts": [], "missions": [], "questions": [], "dailyGuidance": [], "dataQuality": { "score": 0, "mainGaps": [], "howToImprove": [] } }',
    'Cada item de "events" deve ter: sourceIndex, domain, box, title, dateHint, status, facts, estimates, metrics, missingFields, confidence.',
    'Use metrics com: moneySpent, moneyEarned, moneyInvested, passiveIncome, caloriesIn, caloriesOut, proteinG, activityMinutes.',
    'lifeDimensions deve conter notas 0-100 para: corpo, mente, alma, social, trabalho, financeiro.',
    'wellbeing deve conter: score 0-100, strengths, risks, nextRituals, socialSignals, meaningSignals, joySignals.',
    'charts deve conter objetos completos, nunca vazios. Cada chart precisa ter title, why, x, y e priority. Se nao houver grafico util, nao inclua o item.',
    'dominantPatterns, dailyGuidance e questions devem ser frases completas e especificas, nunca rotulos genericos.',
    'LIMITES DE TAMANHO PARA EVITAR RESPOSTA TRUNCADA',
    '- summary: maximo 900 caracteres, em texto humano corrido.',
    '- events: maximo 18 eventos, priorizando dinheiro, comida, corpo, sono, missoes e relacoes mais importantes.',
    '- dominantPatterns, dailyGuidance, questions, charts e missions: maximo 8 itens cada.',
    '- facts e missingFields: maximo 6 itens cada.',
    '- Nunca coloque o JSON inteiro dentro de summary. summary deve ser apenas uma leitura humana.',
    '',
    `Periodo analisado: ${periodLabel || 'periodo atual do painel'}`,
    `Perfil: ${profileName || 'Guido / Radar da Vida'}`,
    '',
    'ENTRADAS NORMALIZADAS PARA ANALISE:',
    JSON.stringify(entries, null, 2)
  ].join('\n');
}

async function callOpenAiResponsesWithRetry({ apiKey, model, prompt }) {
  const models = uniqueClean([model, 'gpt-4.1-mini', 'gpt-4o-mini']);
  const attempts = models.map((attemptModel, index) => ({
    model: attemptModel,
    prompt,
    label: index === 0 ? 'primary' : `fallback_model_${index}`
  }));
  let last = null;

  for (const attempt of attempts) {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: attempt.model,
        input: attempt.prompt,
        temperature: 0.2,
        max_output_tokens: 9000
      })
    });

    const body = await response.text();

    if (response.ok) {
      return {
        model: attempt.model,
        attempt: attempt.label,
        body
      };
    }

    last = {
      status: response.status,
      body,
      model: attempt.model,
      attempt: attempt.label
    };

    if (response.status < 500 && response.status !== 429) {
      break;
    }
  }

  const detail = last && last.body ? last.body.slice(0, 1200) : '';
  const status = last ? last.status : 500;
  const error = new Error(`OpenAI HTTP ${status}`);
  error.status = status;
  error.detail = detail;
  error.model = last ? last.model : model;
  throw error;
}

function extractJsonLikeSummary(text) {
  const raw = String(text || '');
  const match = raw.match(/"summary"\s*:\s*"((?:\\.|[^"\\])*)"/);

  if (!match) return '';

  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1].replace(/\\"/g, '"').replace(/\\n/g, ' ');
  }
}

function stringifyPersonalValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') return cleanText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map(stringifyPersonalValue).filter(Boolean).join(' | ');
  }
  if (typeof value === 'object') {
    return cleanText(value.title || value.summary || value.name || value.label || value.why || value.nextAction || '');
  }
  return cleanText(value);
}

function normalizeStringList(value, limit = 8) {
  return (Array.isArray(value) ? value : [])
    .map(stringifyPersonalValue)
    .map(cleanText)
    .filter(Boolean)
    .slice(0, limit);
}

function normalizePersonalAnalysis(analysis, rawText = '') {
  let source = analysis && typeof analysis === 'object' ? { ...analysis } : {};

  if (typeof source.summary === 'string') {
    const summaryText = source.summary.trim();
    if (/^\{/.test(summaryText) && /"summary"\s*:/.test(summaryText)) {
      try {
        const nested = parsePossiblyWrappedJson(summaryText);
        if (nested && typeof nested === 'object') {
          source = { ...nested, ...source, summary: nested.summary || source.summary };
        }
      } catch {
        source.summary = extractJsonLikeSummary(summaryText) || '';
      }
    }
  }

  if (source.summary && typeof source.summary === 'object') {
    source.summary = stringifyPersonalValue(source.summary);
  }

  let summary = cleanText(source.summary);
  if (!summary && rawText) {
    summary = extractJsonLikeSummary(rawText);
  }

  if (/^\{/.test(summary) || /^\[/.test(summary)) {
    summary = 'A IA retornou dados estruturados, mas sem resumo textual confiavel. Os eventos e metricas uteis foram preservados para os graficos e listas.';
  }

  source.summary = cleanText(summary).slice(0, 1200) || 'A IA retornou uma analise estruturada sem resumo textual.';
  source.dominantPatterns = normalizeStringList(source.dominantPatterns, 8);
  source.dailyGuidance = normalizeStringList(source.dailyGuidance, 8);
  source.questions = normalizeStringList(source.questions, 8);
  source.events = (Array.isArray(source.events) ? source.events : []).slice(0, 18);
  source.charts = (Array.isArray(source.charts) ? source.charts : []).filter(Boolean).slice(0, 8);
  source.missions = (Array.isArray(source.missions) ? source.missions : []).filter(Boolean).slice(0, 8);
  source.dataQuality = source.dataQuality && typeof source.dataQuality === 'object' ? source.dataQuality : {};
  source.wellbeing = source.wellbeing && typeof source.wellbeing === 'object' ? source.wellbeing : {};
  source.lifeDimensions = source.lifeDimensions && typeof source.lifeDimensions === 'object' ? source.lifeDimensions : {};
  source.totals = source.totals && typeof source.totals === 'object' ? source.totals : {};

  return source;
}

function summarizeOpenAiError(err) {
  const detail = cleanText(err.detail);

  if (/incorrect api key|invalid api key|invalid_api_key|401/i.test(detail)) {
    return 'A OpenAI recusou a chave. Confira se a API key esta correta.';
  }

  if (/insufficient_quota|quota|billing|credit/i.test(detail)) {
    return 'A chave parece estar sem credito, limite ou billing ativo na OpenAI.';
  }

  if (/model|does not exist|not found/i.test(detail)) {
    return 'O modelo informado nao foi aceito. Tente gpt-4.1-mini.';
  }

  if (/rate limit|429/i.test(detail)) {
    return 'A OpenAI limitou temporariamente as chamadas. Aguarde um pouco e tente novamente.';
  }

  if (err.status >= 500) {
    return 'A OpenAI retornou erro interno temporario. Reduzi o pacote enviado; tente novamente em alguns segundos.';
  }

  return err.message || 'Falha ao chamar a OpenAI.';
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

function buildAutoSaveConfirmationText(analysis, entryId) {
  const insight = analysis.insight_curto || analysis.descricao_visual || 'Foto analisada e salva.';
  const cats = Array.isArray(analysis.categorias) ? analysis.categorias.slice(0, 6).join(', ') : '';

  const moneyParts = [];
  if (analysis.dinheiro_ganho > 0) moneyParts.push(`Ganho: ${formatMoneyForText(analysis.dinheiro_ganho)}`);
  if (analysis.dinheiro_gasto > 0) moneyParts.push(`Gasto: ${formatMoneyForText(analysis.dinheiro_gasto)}`);
  if (analysis.dinheiro_investido > 0) moneyParts.push(`Investido: ${formatMoneyForText(analysis.dinheiro_investido)}`);

  return [
    '📷 Radar Visual salvou sua foto automaticamente.',
    '',
    moneyParts.length ? moneyParts.join(' | ') : '',
    `Insight: ${insight}`,
    cats ? `Categorias: ${cats}` : '',
    entryId ? `ID: ${entryId}` : '',
    '',
    'Se não gostar da leitura, você pode excluir depois pelo painel.'
  ].filter(Boolean).join('\n');
}

app.get('/', (req, res) => {
  const indexPath = path.join(publicDir, 'index.html');

  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }

  return res.json({
    ok: true,
    app: 'Radar de Vida v7.5 — Radar Visual Documental',
    status: 'online',
    now: nowIso(),
    message: 'Backend online, mas public/index.html não foi encontrado.',
    expectedFile: 'public/index.html',
    endpoints: {
      health: '/health',
      test: '/test',
      whatsapp: '/webhook/whatsapp',
      analyzeEntry: '/api/analyze-entry',
      personalIntelligence: '/api/personal-intelligence',
      manualEntry: '/api/manual-entry',
      deleteEntry: '/api/delete-entry'
    },
    config: {
      hasGoogleDocsApiUrl: Boolean(GOOGLE_DOCS_API_URL),
      hasOpenAiApiKey: Boolean(OPENAI_API_KEY),
      hasWhatsappCloudToken: Boolean(WHATSAPP_CLOUD_TOKEN),
      hasRadarApiToken: Boolean(RADAR_API_TOKEN),
      openaiVisionModel: OPENAI_VISION_MODEL,
      openaiTextModel: OPENAI_TEXT_MODEL,
      openaiTextModelSource: OPENAI_TEXT_MODEL_INFO.source,
      ignoredLegacyOpenAIModel: OPENAI_TEXT_MODEL_INFO.ignoredLegacyModel,
      openaiAudioModel: OPENAI_AUDIO_MODEL,
      sendWhatsappConfirmation: SEND_WHATSAPP_CONFIRMATION,
      logRawWhatsappEmpty: LOG_RAW_WHATSAPP_EMPTY
    }
  });
});

app.get('/health', async (req, res) => {
  const base = {
    ok: true,
    app: 'Radar de Vida v7.5 — Radar Visual Documental',
    status: 'online',
    now: nowIso(),
    hasGoogleDocsApiUrl: Boolean(GOOGLE_DOCS_API_URL),
    hasOpenAiApiKey: Boolean(OPENAI_API_KEY),
    hasWhatsappCloudToken: Boolean(WHATSAPP_CLOUD_TOKEN),
    hasRadarApiToken: Boolean(RADAR_API_TOKEN),
    openaiVisionModel: OPENAI_VISION_MODEL,
    openaiTextModel: OPENAI_TEXT_MODEL,
    openaiTextModelSource: OPENAI_TEXT_MODEL_INFO.source,
    ignoredLegacyOpenAIModel: OPENAI_TEXT_MODEL_INFO.ignoredLegacyModel,
    openaiAudioModel: OPENAI_AUDIO_MODEL,
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
  if (!requireRadarApiToken(req, res)) return;

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

app.post('/api/analyze-entry', async (req, res) => {
  if (!requireRadarApiToken(req, res)) return;

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
    const intelligence = await analyzeTextWithRadarIntelligence({
      text,
      from: cleanText(req.body.from) || 'analysis_api',
      profileName: cleanText(req.body.profileName) || 'Analysis API',
      source: 'render_analysis_api',
      raw: {
        body: req.body,
        ip: getClientIp(req)
      }
    });

    return res.status(200).json({
      ok: true,
      text,
      intelligence,
      legacyFields: buildLegacyFieldsFromRadarIntelligence(intelligence)
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.post('/api/personal-intelligence', async (req, res) => {
  const apiKey =
    cleanText(req.body.openaiApiKey) ||
    cleanText(req.body.apiKey);
  const model =
    cleanText(req.body.model) ||
    OPENAI_TEXT_MODEL;
  const rawEntries = Array.isArray(req.body.entries) ? req.body.entries : [];

  if (!apiKey) {
    return res.status(400).json({
      ok: false,
      error: 'Informe uma OpenAI API key para usar o GPT interno pessoal.'
    });
  }

  if (!rawEntries.length) {
    return res.status(400).json({
      ok: false,
      error: 'Nenhuma entrada enviada para analise.'
    });
  }

  const entries = rawEntries.slice(0, 50).map((entry, index) => ({
    index,
    id: cleanText(entry.id),
    date: cleanText(entry.data_br || entry.data_iso || entry.date),
    time: cleanText(entry.hora_br || entry.time),
    text: normalizeWhitespace(entry.entrada_original || entry.text || '').slice(0, 650),
    type: cleanText(entry.tipo_principal || entry.type),
    categories: Array.isArray(entry.categorias) ? entry.categorias.slice(0, 12) : [],
    boxes: Array.isArray(entry.radar_boxes) ? entry.radar_boxes.slice(0, 12) : [],
    moneySpent: toNumber(entry.dinheiro_gasto),
    moneyEarned: toNumber(entry.dinheiro_ganho),
    moneyInvested: toNumber(entry.dinheiro_investido),
    passiveIncome: toNumber(entry.renda_passiva || entry.passive_income),
    caloriesIn: toNumber(entry.calorias_ingeridas || entry.calorias_ingeridas_sugeridas),
    caloriesOut: toNumber(entry.calorias_gastas || entry.calorias_gastas_sugeridas),
    proteinG: toNumber(entry.proteina_g || entry.proteina_g_sugerida),
    sportMinutes: toNumber(entry.esporte_minutos || entry.atividade_fisica_minutos),
    productiveMinutes: toNumber(entry.trabalho_minutos || entry.estudo_minutos || entry.projeto_minutos),
    shortInsight: cleanText(entry.insight_curto).slice(0, 280),
    deepInsight: cleanText(entry.insight_profundo).slice(0, 280)
  })).filter(entry => entry.text);

  const prompt = buildPersonalRadarPrompt({
    entries,
    periodLabel: cleanText(req.body.periodLabel),
    profileName: cleanText(req.body.profileName)
  });

  try {
    const openAiResult = await callOpenAiResponsesWithRetry({ apiKey, model, prompt });
    const parsed = JSON.parse(openAiResult.body);
    const outputText = extractOpenAIText(parsed);
    let analysis;

    try {
      analysis = parsePossiblyWrappedJson(outputText);
    } catch {
      analysis = {
        summary: extractJsonLikeSummary(outputText) || outputText,
        dominantPatterns: [],
        events: [],
        totals: {},
        charts: [],
        missions: [],
        questions: [],
        dailyGuidance: [],
        dataQuality: {
          score: 0,
          mainGaps: ['A resposta da IA nao veio em JSON estruturado.'],
          howToImprove: ['Rodar novamente ou reduzir o periodo analisado.']
        }
      };
    }

    analysis = normalizePersonalAnalysis(analysis, outputText);

    return res.status(200).json({
      ok: true,
      model: openAiResult.model,
      openAiAttempt: openAiResult.attempt,
      entriesAnalyzed: entries.length,
      entriesReceived: rawEntries.length,
      analysis
    });
  } catch (err) {
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    return res.status(status).json({
      ok: false,
      error: summarizeOpenAiError(err),
      technicalError: err.message,
      detail: cleanText(err.detail).slice(0, 1000)
    });
  }
});

app.post('/api/delete-entry', async (req, res) => {
  if (!requireRadarApiToken(req, res)) return;

  const id =
    cleanText(req.body.id) ||
    cleanText(req.body.entryId) ||
    cleanText(req.query.id);
  const requestedMode =
    cleanText(req.body.mode) ||
    cleanText(req.body.deleteMode) ||
    cleanText(req.query.mode) ||
    'system';
  const mode = requestedMode === 'permanent' ? 'permanent' : 'system';
  const action = mode === 'permanent' ? 'delete_permanent' : 'delete';

  if (!id) {
    return res.status(400).json({
      ok: false,
      error: 'Campo id/entryId vazio.'
    });
  }

  try {
    const result = await callAppsScriptAction({
      action,
      id,
      mode
    });

    return res.status(result.ok ? 200 : 500).json({
      ok: Boolean(result.ok),
      id,
      mode,
      action,
      result
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message,
      id,
      mode,
      action
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
   * Fluxo de áudio:
   * Áudio WhatsApp -> Meta Cloud API -> OpenAI Transcription -> Apps Script.
   */
  if (incoming.media && /^audio/i.test(incoming.media.type || incoming.media.mimeType || '')) {
    try {
      const audioFile = await getAudioFileFromMedia(incoming.media);
      const transcript = await transcribeAudioWithOpenAI({
        audioFile,
        from: incoming.from,
        profileName: incoming.profileName
      });

      if (!transcript) {
        throw new Error('Transcrição vazia.');
      }

      const text = `Transcrição de áudio do WhatsApp: ${transcript}`;
      const result = await sendTextToAppsScript({
        text,
        from: incoming.from,
        profileName: incoming.profileName,
        source: 'whatsapp_audio_transcription',
        raw: {
          body: incoming.raw,
          source: incoming.source,
          audio: {
            mimeType: audioFile.mime,
            filename: audioFile.filename,
            provider: incoming.media.provider || '',
            mediaId: incoming.media.id || '',
            transcriptionEngine: OPENAI_AUDIO_MODEL
          },
          transcript
        }
      });

      console.log('[RADAR_AUDIO] Áudio transcrito e enviado ao Apps Script:', {
        ok: result.ok,
        id: result.id,
        transcriptPreview: transcript.slice(0, 180),
        error: result.error || null
      });

      if (SEND_WHATSAPP_CONFIRMATION) {
        return res.status(200).type('text/xml').send(buildWhatsappXmlMessage(
          result.ok
            ? `Áudio transcrito e registrado no Radar de Vida.\n\n${transcript.slice(0, 500)}`
            : 'Recebi o áudio e transcrevi, mas houve erro ao registrar no Radar de Vida.'
        ));
      }

      return res.status(result.ok ? 200 : 500).json({
        ok: Boolean(result.ok),
        action: 'audio_transcribed_saved',
        transcript,
        result
      });
    } catch (err) {
      console.error('[RADAR_AUDIO] Erro ao transcrever/salvar áudio:', err);

      const msg = 'Recebi o áudio, mas ainda não consegui transcrevê-lo. Erro: ' + err.message;

      if (SEND_WHATSAPP_CONFIRMATION) {
        return res.status(200).type('text/xml').send(buildWhatsappXmlMessage(msg));
      }

      return res.status(200).json({
        ok: false,
        action: 'audio_transcription_failed',
        error: err.message,
        hint: 'Verifique OPENAI_API_KEY, WHATSAPP_CLOUD_TOKEN, ID/URL da mídia de áudio e permissões da Meta.'
      });
    }
  }

  /**
   * Fluxo visual v7.5:
   * Foto analisada com prompt documental e salva diretamente pelo Apps Script.
   */
  if (incoming.media) {
    try {
      const imageDataUrl = await getImageDataUrl(incoming.media);

      const rawAnalysis = await analyzeImageWithOpenAI({
        imageDataUrl,
        caption: incoming.text,
        from: incoming.from,
        profileName: incoming.profileName
      });

      const analysis = enhanceVisualAnalysisForAutoSave(rawAnalysis);

      const visualResult = await createVisualEntryInAppsScript({
        from: incoming.from,
        profileName: incoming.profileName,
        originalText: incoming.text,
        mediaInfo: {
          type: incoming.media.type || 'image',
          mimeType: incoming.media.mimeType || '',
          sourcePath: incoming.source.mediaPath || '',
          provider: incoming.media.provider || '',
          visualEngine: 'openai_vision_documental_v7_5'
        },
        analysis,
        raw: {
          body: incoming.raw,
          source: incoming.source,
          visualEngine: 'openai_vision_documental_v7_5'
        }
      });

      console.log('[RADAR_VISUAL_V7_5] Foto analisada e salva:', {
        ok: visualResult.ok,
        entryId: visualResult.entryId || visualResult.id || null,
        dinheiro_ganho: analysis.dinheiro_ganho,
        dinheiro_gasto: analysis.dinheiro_gasto,
        dinheiro_investido: analysis.dinheiro_investido,
        ativos: analysis.ativos_detectados || [],
        error: visualResult.error || null
      });

      const confirmationText = buildAutoSaveConfirmationText(
        analysis,
        visualResult.entryId || visualResult.id || ''
      );

      if (SEND_WHATSAPP_CONFIRMATION) {
        return res.status(200).type('text/xml').send(buildWhatsappXmlMessage(confirmationText));
      }

      return res.status(200).json({
        ok: Boolean(visualResult.ok),
        action: 'visual_documental_saved',
        entryId: visualResult.entryId || visualResult.id || '',
        analysis,
        result: visualResult
      });

    } catch (err) {
      console.error('[RADAR_VISUAL_V7_5] Erro ao analisar/salvar imagem:', err);

      const msg = 'Recebi a foto, mas ainda não consegui analisá-la. Erro: ' + err.message;

      if (SEND_WHATSAPP_CONFIRMATION) {
        return res.status(200).type('text/xml').send(buildWhatsappXmlMessage(msg));
      }

      return res.status(200).json({
        ok: false,
        action: 'visual_documental_failed',
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
  console.log(`Radar de Vida v7.5 — Radar Visual Documental online na porta ${PORT}`);
  console.log('GOOGLE_DOCS_API_URL configurada:', Boolean(GOOGLE_DOCS_API_URL));
  console.log('OPENAI_API_KEY configurada no Render:', Boolean(OPENAI_API_KEY));
  console.log('WHATSAPP_CLOUD_TOKEN configurado no Render:', Boolean(WHATSAPP_CLOUD_TOKEN));
  console.log('OPENAI_VISION_MODEL:', OPENAI_VISION_MODEL);
  console.log('OPENAI_AUDIO_MODEL:', OPENAI_AUDIO_MODEL);
  console.log('SEND_WHATSAPP_CONFIRMATION:', SEND_WHATSAPP_CONFIRMATION);
  console.log('LOG_RAW_WHATSAPP_EMPTY:', LOG_RAW_WHATSAPP_EMPTY);
  console.log('public/index.html encontrado:', fs.existsSync(path.join(publicDir, 'index.html')));
});
