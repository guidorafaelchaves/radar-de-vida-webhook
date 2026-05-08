import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "radar_de_vida_teste_123";

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";
const WHATSAPP_GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || "v23.0";
const META_APP_SECRET = process.env.META_APP_SECRET || "";

const GOOGLE_SHEETS_API_URL = process.env.GOOGLE_SHEETS_API_URL || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const SEND_WHATSAPP_CONFIRMATION = String(process.env.SEND_WHATSAPP_CONFIRMATION || "false") === "true";

const DB_FILE = path.resolve(__dirname, process.env.DB_FILE || "./data/radar-db.json");

const app = express();

app.use(express.json({
  limit: "6mb",
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

app.use(cors());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan("dev"));
app.use(express.static(path.join(__dirname, "public")));

ensureDB();

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "Radar de Vida WhatsApp Webhook",
    version: "0.3.0-gpt-delete",
    time: new Date().toISOString(),
    whatsappConfigured: Boolean(WHATSAPP_TOKEN && WHATSAPP_PHONE_NUMBER_ID),
    googleSheetsConfigured: Boolean(GOOGLE_SHEETS_API_URL),
    openaiConfigured: Boolean(OPENAI_API_KEY),
    openaiModel: OPENAI_MODEL,
    webhookUrl: "/webhook/whatsapp"
  });
});

app.get("/webhook/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado pela Meta.");
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post("/webhook/whatsapp", async (req, res) => {
  try {
    if (!isValidMetaSignature(req)) {
      console.warn("Assinatura Meta inválida.");
      return res.sendStatus(403);
    }

    const payload = req.body;
    saveRawWebhook(payload);

    const messages = extractWhatsAppMessages(payload);

    for (const msg of messages) {
      await processIncomingMessage(msg, payload);
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error("Erro no webhook:", error);
    return res.sendStatus(200);
  }
});

app.post("/api/test-message", async (req, res) => {
  try {
    const text = String(req.body?.text || "").trim();
    if (!text) return res.status(400).json({ ok: false, error: "Campo text é obrigatório." });

    const record = await processIncomingMessage({
      id: "local_" + uid(),
      from: String(req.body?.from || "teste-local"),
      name: String(req.body?.name || "Usuário Teste"),
      text,
      timestamp: Math.floor(Date.now() / 1000),
      type: "text",
      source: "api_test"
    }, { source: "api_test" });

    res.json({ ok: true, record });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/analyze-text", async (req, res) => {
  try {
    const record = req.body?.record || {};
    const text = String(record.descricao || record.originalText || record.titulo || req.body?.text || "").trim();

    if (!text) return res.status(400).json({ ok: false, error: "Texto ausente." });

    const analysis = await analyzeTextWithOpenAI(text, record, req.body?.prompt || "");

    res.json({ ok: true, analysis });
  } catch (error) {
    console.error("Erro em /api/analyze-text:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/analyze-records", async (req, res) => {
  try {
    const records = Array.isArray(req.body?.records) ? req.body.records : [];
    const prompt = req.body?.prompt || "";

    if (!records.length) return res.status(400).json({ ok: false, error: "Nenhum registro informado." });

    const analyses = [];

    for (const record of records.slice(0, 80)) {
      const text = String(record.descricao || record.originalText || record.titulo || "").trim();
      if (!text) continue;

      const analysis = await analyzeTextWithOpenAI(text, record, prompt);
      analyses.push({
        id: record.id,
        ...analysis
      });
    }

    res.json({ ok: true, total: analyses.length, analyses });
  } catch (error) {
    console.error("Erro em /api/analyze-records:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/delete-record", async (req, res) => {
  try {
    const id = String(req.body?.id || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "ID não informado." });

    const sheetsResult = await deleteRecordFromGoogleSheets(id);
    deleteRecordFromLocalDB(id);

    if (!sheetsResult.ok) {
      return res.status(500).json({
        ok: false,
        error: sheetsResult.error || "Falha ao excluir no Google Sheets.",
        detail: sheetsResult
      });
    }

    res.json({ ok: true, id, sheetsResult });
  } catch (error) {
    console.error("Erro em /api/delete-record:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/records", (req, res) => {
  const db = readDB();
  res.json({
    ok: true,
    records: db.records.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  });
});

async function processIncomingMessage(msg, originalPayload) {
  const text = String(msg.text || "").trim();
  if (!text) return null;

  const eventDateTime = msg.timestamp
    ? new Date(Number(msg.timestamp) * 1000).toISOString()
    : new Date().toISOString();

  const db = readDB();

  if (msg.id && db.records.some(record => record.whatsappMessageId === msg.id)) {
    return db.records.find(record => record.whatsappMessageId === msg.id);
  }

  const baseRecord = {
    id: "rec_" + uid(),
    source: msg.source || "whatsapp",
    whatsappMessageId: msg.id || null,
    from: msg.from || null,
    name: msg.name || null,
    type: msg.type || "text",
    originalText: text,
    createdAt: new Date().toISOString(),
    eventDateTime,
    originalPayloadSummary: summarizePayload(originalPayload)
  };

  let analysis;

  try {
    analysis = await analyzeTextWithOpenAI(text, baseRecord, "");
  } catch (error) {
    console.warn("OpenAI indisponível; usando heurística local:", error.message);
    analysis = heuristicAnalysis(text, eventDateTime);
  }

  const record = {
    ...baseRecord,
    analysis
  };

  db.records.push(record);
  writeDB(db);

  console.log("Registro salvo localmente:", record.id, record.originalText);

  const sheetsResult = await sendRecordToGoogleSheets(record);

  if (sheetsResult.ok) console.log("Registro enviado ao Google Sheets:", record.id);
  else console.error("Falha ao enviar ao Google Sheets:", sheetsResult.error);

  if (SEND_WHATSAPP_CONFIRMATION && msg.from && WHATSAPP_TOKEN && WHATSAPP_PHONE_NUMBER_ID) {
    await sendWhatsAppText(
      msg.from,
      sheetsResult.ok
        ? "Registrado no Radar de Vida."
        : "Registro recebido, mas houve falha ao salvar no Google Sheets."
    );
  }

  return record;
}

async function analyzeTextWithOpenAI(text, record = {}, extraPrompt = "") {
  if (!OPENAI_API_KEY) {
    return heuristicAnalysis(text, new Date().toISOString());
  }

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      area_principal: { type: "string" },
      subarea: { type: "string" },
      titulo: { type: "string" },
      resumo: { type: "string" },
      polaridade: {
        type: "string",
        enum: ["positivo", "negativo", "neutro", "misto", "alerta"]
      },
      intensidade: {
        type: "string",
        enum: ["baixa", "media", "alta"]
      },
      score_ia: { type: "number" },
      valor_gasto: { type: "number" },
      valor_ganho: { type: "number" },
      horas_usadas: { type: "number" },
      tags: {
        type: "array",
        items: { type: "string" }
      },
      acao_sugerida: { type: "string" },
      confianca: { type: "number" }
    },
    required: [
      "area_principal",
      "subarea",
      "titulo",
      "resumo",
      "polaridade",
      "intensidade",
      "score_ia",
      "valor_gasto",
      "valor_ganho",
      "horas_usadas",
      "tags",
      "acao_sugerida",
      "confianca"
    ]
  };

  const system = `
Você é o motor de classificação do aplicativo Radar de Vida.
Classifique frases pessoais em dimensões humanas diárias, como Saúde, Corpo / Esporte, Finanças, Trabalho, Jurídico, Relacionamento, Família, Social, Projetos, Emocional, Espiritualidade / Sentido, Casa / Rotina, Aprendizado, Lazer ou Geral.

Extraia com atenção:
- reais gastos: compras, pagamentos, despesas, multas, custos;
- reais ganhos: recebimentos, vendas, reembolsos, lucros, entradas;
- horas usadas: atividades mencionadas em horas/minutos;
- polaridade, intensidade, score de 0 a 100 e ação sugerida.

Não invente valores monetários ou horas. Se não houver, use 0.
`.trim();

  const user = JSON.stringify({ text, record, extraPrompt }, null, 2);

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "radar_vida_analysis",
          strict: true,
          schema
        }
      }
    })
  });

  const raw = await response.text();

  if (!response.ok) {
    throw new Error(`OpenAI ${response.status}: ${raw.slice(0, 600)}`);
  }

  const json = JSON.parse(raw);
  const outputText = extractResponseText(json);

  if (!outputText) {
    throw new Error("Resposta da OpenAI sem texto estruturado.");
  }

  const analysis = JSON.parse(outputText);

  analysis.score_ia = clampNumber(Number(analysis.score_ia || 70), 0, 100);
  analysis.valor_gasto = Number(analysis.valor_gasto || 0);
  analysis.valor_ganho = Number(analysis.valor_ganho || 0);
  analysis.horas_usadas = Number(analysis.horas_usadas || 0);
  analysis.confianca = clampNumber(Number(analysis.confianca || 0.7), 0, 1);

  return analysis;
}

function extractResponseText(json) {
  if (json.output_text) return json.output_text;

  const parts = [];

  for (const item of json.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) parts.push(content.text);
      if (content.text) parts.push(content.text);
    }
  }

  return parts.join("\n").trim();
}

async function sendRecordToGoogleSheets(record) {
  if (!GOOGLE_SHEETS_API_URL) {
    return { ok: false, error: "GOOGLE_SHEETS_API_URL não configurada." };
  }

  const payload = {
    action: "create",
    data: convertRecordToSheetsData(record)
  };

  return postToSheets(payload);
}

async function deleteRecordFromGoogleSheets(id) {
  if (!GOOGLE_SHEETS_API_URL) {
    return { ok: false, error: "GOOGLE_SHEETS_API_URL não configurada." };
  }

  return postToSheets({ action: "delete", id });
}

async function postToSheets(payload) {
  try {
    const response = await fetch(GOOGLE_SHEETS_API_URL, {
      method: "POST",
      redirect: "follow",
      headers: {
        "Content-Type": "text/plain;charset=utf-8"
      },
      body: JSON.stringify(payload)
    });

    const text = await response.text();

    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: text.slice(0, 500)
      };
    }

    if (json && json.ok === false) {
      return {
        ok: false,
        status: response.status,
        error: json.erro || json.error || "Apps Script retornou erro."
      };
    }

    return {
      ok: true,
      status: response.status,
      response: json || text.slice(0, 500)
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message
    };
  }
}

function convertRecordToSheetsData(record) {
  const analysis = record.analysis || {};
  const titulo = analysis.titulo || resumoCurto(record.originalText) || "Mensagem WhatsApp";

  return {
    id: record.id,
    data_criacao: record.createdAt,
    data_atualizacao: new Date().toISOString(),
    origem: record.source === "api_test" ? "api_test_render" : "whatsapp_render",
    tipo: "Mensagem WhatsApp",
    categoria: analysis.area_principal || "Geral",
    titulo,
    descricao: record.originalText,
    data_evento: record.eventDateTime ? String(record.eventDateTime).slice(0, 10) : "",
    hora_evento: record.eventDateTime ? String(record.eventDateTime).slice(11, 16) : "",
    prioridade: analysis.polaridade === "alerta" ? "Alta" : "Normal",
    status: "Aberto",
    tags: Array.isArray(analysis.tags) ? analysis.tags : ["whatsapp"],
    contato_nome: record.name || "",
    contato_numero: record.from || "",
    whatsapp_msg_id: record.whatsappMessageId || "",
    tem_midia: record.type && record.type !== "text" ? "Sim" : "Não",
    midia_ids: [],
    area_principal: analysis.area_principal || "",
    subarea: analysis.subarea || "",
    polaridade: analysis.polaridade || "",
    intensidade: analysis.intensidade || "",
    score_ia: analysis.score_ia || "",
    valor_gasto: analysis.valor_gasto || 0,
    valor_ganho: analysis.valor_ganho || 0,
    horas_usadas: analysis.horas_usadas || 0,
    acao_sugerida: analysis.acao_sugerida || "",
    analise_ia_json: JSON.stringify(analysis),
    json_original: JSON.stringify({ record, analysis })
  };
}

function extractWhatsAppMessages(payload) {
  const out = [];
  const entries = payload?.entry || [];

  for (const entry of entries) {
    for (const change of entry?.changes || []) {
      const value = change?.value || {};
      const contacts = value.contacts || [];
      const messages = value.messages || [];

      for (const message of messages) {
        const contact = contacts.find(c => c.wa_id === message.from) || contacts[0] || {};
        let text = "";

        if (message.type === "text") text = message.text?.body || "";
        else if (message.type === "button") text = message.button?.text || "";
        else if (message.type === "interactive") {
          text =
            message.interactive?.button_reply?.title ||
            message.interactive?.list_reply?.title ||
            "";
        } else {
          text = `[${message.type || "midia"} recebido — análise de mídia ainda não implementada]`;
        }

        out.push({
          id: message.id,
          from: message.from,
          name: contact?.profile?.name || null,
          text,
          timestamp: message.timestamp,
          type: message.type || "unknown",
          source: "whatsapp"
        });
      }
    }
  }

  return out;
}

function heuristicAnalysis(text, eventDateTime) {
  const lower = text.toLowerCase();
  let area = "Geral";
  let polaridade = "neutro";
  let score = 70;

  if (/(r\$|paguei|comprei|gastei|recebi|ganhei|vendi|pix|boleto)/i.test(text)) area = "Finanças";
  else if (/(academia|treino|caminh|corrida|exerc)/i.test(text)) area = "Corpo / Esporte";
  else if (/(processo|petição|prazo|juiz|vara|pje|unimed)/i.test(text)) area = "Jurídico";
  else if (/(sono|dor|médico|medico|remédio|consulta)/i.test(text)) area = "Saúde";
  else if (/(projeto|app|radar|webhook|api)/i.test(text)) area = "Projetos";

  if (/(urgente|erro|falha|dor|ruim|gastei|paguei)/i.test(text)) {
    polaridade = "negativo";
    score -= 12;
  }

  if (/(funcionou|consegui|recebi|ganhei|bom|boa|excelente)/i.test(text)) {
    polaridade = "positivo";
    score += 10;
  }

  const money = extractMoney(text);
  const horas = extractHours(text);

  return {
    area_principal: area,
    subarea: "",
    titulo: resumoCurto(text),
    resumo: text,
    polaridade,
    intensidade: "media",
    score_ia: clampNumber(score, 0, 100),
    valor_gasto: money.gasto,
    valor_ganho: money.ganho,
    horas_usadas: horas,
    tags: ["whatsapp", area.toLowerCase()],
    acao_sugerida: "Revisar este registro no painel.",
    confianca: 0.55
  };
}

function extractMoney(text) {
  let gasto = 0;
  let ganho = 0;
  const re = /r\$\s*([\d\.]+,\d{2}|[\d]+,\d{2}|[\d\.]+)/gi;
  let m;

  while ((m = re.exec(text)) !== null) {
    const value = parseBrazilianMoney(m[1]);
    const context = text.slice(Math.max(0, m.index - 50), m.index + 70).toLowerCase();

    if (/(recebi|ganhei|vendi|lucro|entrada|reembolso)/i.test(context)) ganho += value;
    else gasto += value;
  }

  return { gasto, ganho };
}

function extractHours(text) {
  let total = 0;
  let m;
  const hh = /(\d{1,2})h(\d{1,2})/gi;
  const h = /(\d+(?:[.,]\d+)?)\s*(h|hora|horas)\b/gi;
  const min = /(\d+(?:[.,]\d+)?)\s*(min|minuto|minutos)\b/gi;

  while ((m = hh.exec(text)) !== null) total += parseInt(m[1], 10) + parseInt(m[2], 10) / 60;
  while ((m = h.exec(text)) !== null) total += parseFloat(String(m[1]).replace(",", "."));
  while ((m = min.exec(text)) !== null) total += parseFloat(String(m[1]).replace(",", ".")) / 60;

  return Number(total.toFixed(2));
}

function parseBrazilianMoney(raw) {
  let s = String(raw || "").trim();

  if (s.includes(",") && s.includes(".")) s = s.replace(/\./g, "").replace(",", ".");
  else if (s.includes(",")) s = s.replace(",", ".");

  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function summarizePayload(payload) {
  return {
    object: payload?.object,
    entryCount: payload?.entry?.length || 0,
    receivedAt: new Date().toISOString()
  };
}

function buildWhatsAppConfirmation(record) {
  return "Registrado no Radar de Vida.";
}

async function sendWhatsAppText(to, text) {
  const url = `https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const body = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: {
      preview_url: false,
      body: clamp(String(text || ""), 900)
    }
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) console.error("Erro ao responder WhatsApp:", await response.text());
    return response.ok;
  } catch (error) {
    console.error("Erro ao enviar confirmação WhatsApp:", error);
    return false;
  }
}

function isValidMetaSignature(req) {
  if (!META_APP_SECRET) return true;

  const signature = req.headers["x-hub-signature-256"];
  if (!signature || !req.rawBody) return false;

  const expected =
    "sha256=" +
    crypto
      .createHmac("sha256", META_APP_SECRET)
      .update(req.rawBody)
      .digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

function ensureDB() {
  const dir = path.dirname(DB_FILE);

  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (!fs.existsSync(DB_FILE)) {
    writeDB({
      createdAt: new Date().toISOString(),
      records: [],
      rawWebhooks: []
    });
  }
}

function readDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {
    return {
      createdAt: new Date().toISOString(),
      records: [],
      rawWebhooks: []
    };
  }
}

function writeDB(db) {
  const dir = path.dirname(DB_FILE);

  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function saveRawWebhook(payload) {
  const db = readDB();

  db.rawWebhooks = db.rawWebhooks || [];

  db.rawWebhooks.push({
    id: "raw_" + uid(),
    receivedAt: new Date().toISOString(),
    payload
  });

  if (db.rawWebhooks.length > 50) db.rawWebhooks = db.rawWebhooks.slice(-50);

  writeDB(db);
}

function deleteRecordFromLocalDB(id) {
  const db = readDB();

  db.records = (db.records || []).filter(r => String(r.id) !== String(id));

  writeDB(db);
}

function uid() {
  return crypto.randomBytes(8).toString("hex");
}

function clamp(text, max) {
  const s = String(text || "");

  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function clampNumber(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function resumoCurto(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();

  if (!clean) return "Mensagem WhatsApp";

  return clean.length <= 80 ? clean : clean.slice(0, 77) + "...";
}

app.listen(PORT, () => {
  console.log(`Radar de Vida webhook v6 rodando na porta ${PORT}`);
});
