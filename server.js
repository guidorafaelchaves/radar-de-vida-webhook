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
    app: 'Radar de Vida v7.5 — Radar Visual Documental',
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
  console.log('SEND_WHATSAPP_CONFIRMATION:', SEND_WHATSAPP_CONFIRMATION);
  console.log('LOG_RAW_WHATSAPP_EMPTY:', LOG_RAW_WHATSAPP_EMPTY);
  console.log('public/index.html encontrado:', fs.existsSync(path.join(publicDir, 'index.html')));
});
