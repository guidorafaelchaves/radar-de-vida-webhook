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

const SEND_WHATSAPP_CONFIRMATION =
  String(process.env.SEND_WHATSAPP_CONFIRMATION || "true") === "true";

const DB_FILE = path.resolve(
  __dirname,
  process.env.DB_FILE || "./data/radar-db.json"
);

const app = express();

app.use(
  express.json({
    limit: "4mb",
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  })
);

app.use(cors());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan("dev"));
app.use(express.static(path.join(__dirname, "public")));

ensureDB();

/************************************************************
 * HEALTH
 ************************************************************/

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "Radar de Vida WhatsApp Webhook",
    version: "0.2.0-sheets",
    time: new Date().toISOString(),
    whatsappConfigured: Boolean(WHATSAPP_TOKEN && WHATSAPP_PHONE_NUMBER_ID),
    googleSheetsConfigured: Boolean(GOOGLE_SHEETS_API_URL),
    webhookUrl: "/webhook/whatsapp"
  });
});

/************************************************************
 * WEBHOOK WHATSAPP — VERIFICAÇÃO META
 ************************************************************/

app.get("/webhook/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado pela Meta.");
    return res.status(200).send(challenge);
  }

  console.warn("Falha na verificação do webhook:", {
    mode,
    tokenInformado: token ? "***" : null
  });

  return res.sendStatus(403);
});

/************************************************************
 * WEBHOOK WHATSAPP — RECEBIMENTO REAL
 ************************************************************/

app.post("/webhook/whatsapp", async (req, res) => {
  try {
    if (!isValidMetaSignature(req)) {
      console.warn("Assinatura Meta inválida.");
      return res.sendStatus(403);
    }

    const payload = req.body;

    saveRawWebhook(payload);

    const messages = extractWhatsAppMessages(payload);

    if (!messages.length) {
      return res.sendStatus(200);
    }

    for (const msg of messages) {
      await processIncomingMessage(msg, payload);
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error("Erro no webhook:", error);
    return res.sendStatus(200);
  }
});

/************************************************************
 * TESTE MANUAL
 ************************************************************/

app.post("/api/test-message", async (req, res) => {
  try {
    const text = String(req.body?.text || "").trim();
    const from = String(req.body?.from || "teste-local");
    const name = String(req.body?.name || "Usuário Teste");

    if (!text) {
      return res.status(400).json({
        ok: false,
        error: "Campo text é obrigatório."
      });
    }

    const record = await processIncomingMessage(
      {
        id: "local_" + uid(),
        from,
        name,
        text,
        timestamp: Math.floor(Date.now() / 1000),
        type: "text",
        source: "api_test"
      },
      { source: "api_test" }
    );

    res.json({
      ok: true,
      record
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/api/records", (req, res) => {
  const db = readDB();

  res.json({
    ok: true,
    records: db.records.sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    )
  });
});

app.get("/api/export", (req, res) => {
  const db = readDB();

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="radar-webhook-backup-${new Date()
      .toISOString()
      .slice(0, 10)}.json"`
  );

  res.send(JSON.stringify(db, null, 2));
});

/************************************************************
 * PROCESSAMENTO DA MENSAGEM
 ************************************************************/

async function processIncomingMessage(msg, originalPayload) {
  const text = String(msg.text || "").trim();

  if (!text) {
    return null;
  }

  const eventDateTime = msg.timestamp
    ? new Date(Number(msg.timestamp) * 1000).toISOString()
    : new Date().toISOString();

  const db = readDB();

  if (
    msg.id &&
    db.records.some(record => record.whatsappMessageId === msg.id)
  ) {
    console.log("Mensagem duplicada ignorada:", msg.id);

    return db.records.find(record => record.whatsappMessageId === msg.id);
  }

  const analysis = heuristicAnalysis(text, eventDateTime);

  const record = {
    id: "rec_" + uid(),
    source: msg.source || "whatsapp",
    whatsappMessageId: msg.id || null,
    from: msg.from || null,
    name: msg.name || null,
    type: msg.type || "text",
    originalText: text,
    createdAt: new Date().toISOString(),
    eventDateTime,
    analysis,
    originalPayloadSummary: summarizePayload(originalPayload)
  };

  db.records.push(record);
  writeDB(db);

  console.log("Registro salvo localmente:", record.id, record.originalText);

  const sheetsResult = await sendRecordToGoogleSheets(record);

  if (sheetsResult.ok) {
    console.log("Registro enviado ao Google Sheets:", record.id);
  } else {
    console.error("Falha ao enviar ao Google Sheets:", sheetsResult.error);
  }

  if (
    SEND_WHATSAPP_CONFIRMATION &&
    msg.from &&
    WHATSAPP_TOKEN &&
    WHATSAPP_PHONE_NUMBER_ID
  ) {
    const reply = buildWhatsAppConfirmation(record, sheetsResult);
    await sendWhatsAppText(msg.from, reply);
  }

  return record;
}

/************************************************************
 * ENVIO PARA GOOGLE SHEETS / APPS SCRIPT
 ************************************************************/

async function sendRecordToGoogleSheets(record) {
  if (!GOOGLE_SHEETS_API_URL) {
    return {
      ok: false,
      error: "GOOGLE_SHEETS_API_URL não configurada no Render."
    };
  }

  const payload = {
    action: "create",
    data: convertRecordToSheetsData(record)
  };

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
    } catch (e) {
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

  const titulo =
    analysis.resumo_curto ||
    resumoCurto(record.originalText) ||
    "Mensagem WhatsApp";

  const categoria =
    analysis.categoria_principal ||
    analysis.eventos_detectados?.[0]?.categoria_principal ||
    "Geral";

  const tags = Array.isArray(analysis.tags)
    ? analysis.tags
    : ["whatsapp"];

  return {
    id: record.id,
    data_criacao: record.createdAt,
    data_atualizacao: new Date().toISOString(),
    origem: "whatsapp_render",
    tipo: "Mensagem WhatsApp",
    categoria,
    titulo,
    descricao: record.originalText,
    data_evento: record.eventDateTime
      ? String(record.eventDateTime).slice(0, 10)
      : "",
    hora_evento: record.eventDateTime
      ? String(record.eventDateTime).slice(11, 16)
      : "",
    prioridade: analysis.prioridade || "Normal",
    status: "Aberto",
    tags,
    contato_nome: record.name || "",
    contato_numero: record.from || "",
    whatsapp_msg_id: record.whatsappMessageId || "",
    tem_midia: record.type && record.type !== "text" ? "Sim" : "Não",
    midia_ids: [],
    json_original: {
      record,
      analysis
    }
  };
}

/************************************************************
 * EXTRAÇÃO DO PAYLOAD WHATSAPP
 ************************************************************/

function extractWhatsAppMessages(payload) {
  const out = [];
  const entries = payload?.entry || [];

  for (const entry of entries) {
    for (const change of entry?.changes || []) {
      const value = change?.value || {};
      const contacts = value.contacts || [];
      const messages = value.messages || [];

      for (const message of messages) {
        const contact =
          contacts.find(c => c.wa_id === message.from) ||
          contacts[0] ||
          {};

        let text = "";

        if (message.type === "text") {
          text = message.text?.body || "";
        } else if (message.type === "button") {
          text = message.button?.text || "";
        } else if (message.type === "interactive") {
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

function summarizePayload(payload) {
  try {
    return {
      object: payload?.object,
      entryCount: payload?.entry?.length || 0,
      receivedAt: new Date().toISOString()
    };
  } catch {
    return {
      receivedAt: new Date().toISOString()
    };
  }
}

/************************************************************
 * ANÁLISE LOCAL SIMPLES
 ************************************************************/

function heuristicAnalysis(text, eventDateTime) {
  const lower = text.toLowerCase();

  let categoria = "Geral";
  let prioridade = "Normal";

  if (
    lower.includes("urgente") ||
    lower.includes("prazo") ||
    lower.includes("audiência") ||
    lower.includes("audiencia") ||
    lower.includes("processo")
  ) {
    categoria = "Jurídico";
    prioridade = lower.includes("urgente") ? "Urgente" : "Alta";
  } else if (
    lower.includes("remédio") ||
    lower.includes("remedio") ||
    lower.includes("médico") ||
    lower.includes("medico") ||
    lower.includes("consulta") ||
    lower.includes("dor") ||
    lower.includes("sono")
  ) {
    categoria = "Saúde";
  } else if (
    lower.includes("pagar") ||
    lower.includes("boleto") ||
    lower.includes("pix") ||
    lower.includes("dinheiro") ||
    lower.includes("r$")
  ) {
    categoria = "Finanças";
  } else if (
    lower.includes("reunião") ||
    lower.includes("reuniao") ||
    lower.includes("cliente") ||
    lower.includes("trabalho")
  ) {
    categoria = "Trabalho";
  } else if (
    lower.includes("ideia") ||
    lower.includes("projeto") ||
    lower.includes("app")
  ) {
    categoria = "Projeto";
  }

  return {
    texto_original: text,
    resumo_curto: resumoCurto(text),
    categoria_principal: categoria,
    prioridade,
    eventos_detectados: [
      {
        tipo: "mensagem",
        categoria_principal: categoria,
        subcategoria: "whatsapp",
        data_evento: String(eventDateTime).slice(0, 10),
        hora_evento: String(eventDateTime).slice(11, 16),
        impacto: "registro informativo",
        fato_ou_inferencia: "fato",
        confianca: 0.8
      }
    ],
    tags: gerarTags(text, categoria),
    insight_imediato: "Mensagem recebida e registrada no Radar de Vida.",
    resposta_whatsapp_sugerida: "Registrado no Radar de Vida."
  };
}

function resumoCurto(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();

  if (!clean) {
    return "Mensagem WhatsApp";
  }

  if (clean.length <= 80) {
    return clean;
  }

  return clean.slice(0, 77) + "...";
}

function gerarTags(text, categoria) {
  const tags = ["whatsapp", categoria.toLowerCase()];

  const lower = text.toLowerCase();

  if (lower.includes("urgente")) tags.push("urgente");
  if (lower.includes("prazo")) tags.push("prazo");
  if (lower.includes("pix")) tags.push("pix");
  if (lower.includes("consulta")) tags.push("consulta");
  if (lower.includes("processo")) tags.push("processo");

  return Array.from(new Set(tags));
}

/************************************************************
 * RESPOSTA WHATSAPP
 ************************************************************/

function buildWhatsAppConfirmation(record, sheetsResult) {
  if (sheetsResult.ok) {
    return "Registrado no Radar de Vida e salvo no Google Sheets.";
  }

  return "Registrado no Radar de Vida, mas houve falha ao enviar para o Google Sheets. Verifique o painel depois.";
}

async function sendWhatsAppText(to, text) {
  const url = `https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const body = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: {
      preview_url: false,
      body: clamp(text, 900)
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

    if (!response.ok) {
      const err = await response.text();
      console.error("Erro ao responder WhatsApp:", err);
      return false;
    }

    return true;
  } catch (error) {
    console.error("Erro ao enviar confirmação WhatsApp:", error);
    return false;
  }
}

/************************************************************
 * SEGURANÇA META
 ************************************************************/

function isValidMetaSignature(req) {
  if (!META_APP_SECRET) {
    return true;
  }

  const signature = req.headers["x-hub-signature-256"];

  if (!signature || !req.rawBody) {
    return false;
  }

  const expected =
    "sha256=" +
    crypto
      .createHmac("sha256", META_APP_SECRET)
      .update(req.rawBody)
      .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}

/************************************************************
 * BANCO LOCAL DE BACKUP
 ************************************************************/

function ensureDB() {
  const dir = path.dirname(DB_FILE);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

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

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

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

  if (db.rawWebhooks.length > 50) {
    db.rawWebhooks = db.rawWebhooks.slice(-50);
  }

  writeDB(db);
}

/************************************************************
 * UTIL
 ************************************************************/

function uid() {
  return crypto.randomBytes(8).toString("hex");
}

function clamp(text, max) {
  const s = String(text || "");

  if (s.length <= max) {
    return s;
  }

  return s.slice(0, max - 1) + "…";
}

/************************************************************
 * START
 ************************************************************/

app.listen(PORT, () => {
  console.log(`Radar de Vida webhook rodando na porta ${PORT}`);
});
