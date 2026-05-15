// server.js — Radar de Vida consolidado
// WhatsApp → Render → Google Apps Script/Docs → Painel
// Versão com exclusão sincronizada, deduplicação e telas financeiras

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

const GOOGLE_DOCS_API_URL = process.env.GOOGLE_DOCS_API_URL || "";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "radar-de-vida";
const SEND_WHATSAPP_CONFIRMATION =
  String(process.env.SEND_WHATSAPP_CONFIRMATION || "false").toLowerCase() === "true";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(text) {
  return String(text || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function createFingerprint(text, source = "manual", date = "") {
  const base = `${normalizeText(text)}|${source}|${String(date).slice(0, 10)}`;
  return crypto.createHash("sha256").update(base).digest("hex");
}

function createId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return crypto.randomBytes(16).toString("hex");
}

function getMonthKey(dateLike) {
  const d = dateLike ? new Date(dateLike) : new Date();
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 7);
  return d.toISOString().slice(0, 7);
}

function parseBrazilianMoney(raw) {
  if (!raw) return null;

  const text = String(raw).toLowerCase();

  const patterns = [
    /r\$\s*([0-9]{1,3}(?:\.[0-9]{3})*(?:,[0-9]{1,2})?|[0-9]+(?:,[0-9]{1,2})?)/i,
    /([0-9]{1,3}(?:\.[0-9]{3})*(?:,[0-9]{1,2})?|[0-9]+(?:,[0-9]{1,2})?)\s*(?:reais|real)\b/i,
    /\b([0-9]+(?:,[0-9]{1,2})?)\s*(?:conto|contos)\b/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const normalized = match[1].replace(/\./g, "").replace(",", ".");
      const value = Number(normalized);
      if (!Number.isNaN(value)) return value;
    }
  }

  return null;
}

function parseHours(raw) {
  if (!raw) return null;

  const text = String(raw).toLowerCase();

  const patterns = [
    /(\d+(?:[,.]\d+)?)\s*(?:h|hora|horas)\b/i,
    /(\d+(?:[,.]\d+)?)\s*(?:min|minutos)\b/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const value = Number(match[1].replace(",", "."));
      if (Number.isNaN(value)) continue;

      if (pattern.toString().includes("min")) {
        return value / 60;
      }

      return value;
    }
  }

  return null;
}

function inferEntryFromText(text) {
  const t = normalizeText(text);

  const gastoKeywords = [
    "gastei",
    "paguei",
    "comprei",
    "despesa",
    "custou",
    "saiu",
    "pix para",
    "pix de",
    "uber",
    "ifood",
    "mercado",
    "supermercado",
    "farmácia",
    "farmacia",
    "gasolina",
    "combustível",
    "combustivel",
    "almoço",
    "almoco",
    "jantar",
    "lanche",
    "boleto",
    "conta de",
    "energia",
    "água",
    "agua",
    "internet"
  ];

  const ganhoKeywords = [
    "recebi",
    "ganhei",
    "entrou",
    "entrada",
    "honorário",
    "honorarios",
    "honorário",
    "pagamento recebido",
    "cliente pagou",
    "venda",
    "rendimento",
    "dividendo",
    "provento",
    "aluguel recebido",
    "salário",
    "salario"
  ];

  const esporteKeywords = [
    "caminhei",
    "corri",
    "corrida",
    "academia",
    "musculação",
    "musculacao",
    "treino",
    "pedalei",
    "bike",
    "natação",
    "natacao",
    "exercício",
    "exercicio"
  ];

  const trabalhoKeywords = [
    "trabalhei",
    "petição",
    "peticao",
    "processo",
    "audiência",
    "audiencia",
    "cliente",
    "reunião",
    "reuniao",
    "projeto",
    "programando",
    "código",
    "codigo"
  ];

  const amount = parseBrazilianMoney(text);
  const hours = parseHours(text);

  let category = "geral";
  let type = "registro";
  let financialType = null;

  if (gastoKeywords.some((k) => t.includes(k))) {
    category = "financas";
    type = "financeiro";
    financialType = "gasto";
  }

  if (ganhoKeywords.some((k) => t.includes(k))) {
    category = "financas";
    type = "financeiro";
    financialType = "ganho";
  }

  if (!financialType && amount !== null) {
    if (
      t.includes("paguei") ||
      t.includes("gastei") ||
      t.includes("comprei") ||
      t.includes("custou")
    ) {
      category = "financas";
      type = "financeiro";
      financialType = "gasto";
    } else if (
      t.includes("recebi") ||
      t.includes("ganhei") ||
      t.includes("entrou")
    ) {
      category = "financas";
      type = "financeiro";
      financialType = "ganho";
    }
  }

  if (esporteKeywords.some((k) => t.includes(k))) {
    category = "esporte";
    type = "atividade";
  }

  if (trabalhoKeywords.some((k) => t.includes(k))) {
    category = "trabalho";
    type = "atividade";
  }

  return {
    category,
    type,
    financialType,
    amount,
    hours
  };
}

function buildEntry(input = {}) {
  const createdAt = input.createdAt || nowIso();
  const text = String(input.text || input.originalText || "").trim();
  const inferred = inferEntryFromText(text);

  const entry = {
    id: input.id || createId(),
    createdAt,
    updatedAt: nowIso(),
    deletedAt: null,
    status: "ativo",
    source: input.source || "manual",
    text,
    originalText: input.originalText || text,
    category: input.category || inferred.category,
    type: input.type || inferred.type,
    financialType:
      input.financialType ||
      input.tipoFinanceiro ||
      inferred.financialType ||
      null,
    amount:
      typeof input.amount === "number"
        ? input.amount
        : typeof input.valor === "number"
          ? input.valor
          : inferred.amount,
    currency: input.currency || "BRL",
    hours:
      typeof input.hours === "number"
        ? input.hours
        : typeof input.horas === "number"
          ? input.horas
          : inferred.hours,
    month: input.month || getMonthKey(createdAt),
    fingerprint:
      input.fingerprint ||
      createFingerprint(text, input.source || "manual", createdAt),
    raw: input.raw || null
  };

  return entry;
}

async function callGoogle(action, payload = {}) {
  if (!GOOGLE_DOCS_API_URL) {
    throw new Error("GOOGLE_DOCS_API_URL não configurada no Render.");
  }

  const response = await fetch(GOOGLE_DOCS_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      action,
      ...payload
    })
  });

  const text = await response.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`Resposta inválida do Apps Script: ${text.slice(0, 300)}`);
  }

  if (!data.ok) {
    throw new Error(data.error || "Erro desconhecido no Apps Script.");
  }

  return data;
}

async function sendWhatsAppConfirmation(to, receivedText) {
  if (!SEND_WHATSAPP_CONFIRMATION) return;
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID || !to) return;

  const url = `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const body = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: {
      body: `Registro recebido no Radar de Vida: "${receivedText}".`
    }
  };

  try {
    await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
  } catch (err) {
    console.error("Falha ao enviar confirmação WhatsApp:", err.message);
  }
}

app.get("/", (req, res) => {
  res.send("Radar de Vida webhook ativo.");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "radar-de-vida",
    time: nowIso(),
    googleConfigured: Boolean(GOOGLE_DOCS_API_URL)
  });
});

app.get("/api/entries", async (req, res) => {
  try {
    const month = req.query.month || "";
    const includeDeleted = String(req.query.includeDeleted || "false") === "true";

    const data = await callGoogle("list", {
      month,
      includeDeleted
    });

    res.json({
      ok: true,
      entries: data.entries || [],
      stats: data.stats || {}
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.post("/api/entries", async (req, res) => {
  try {
    const entry = buildEntry({
      ...req.body,
      source: req.body.source || "manual"
    });

    if (!entry.text) {
      return res.status(400).json({
        ok: false,
        error: "Texto do registro vazio."
      });
    }

    const data = await callGoogle("append", {
      entry
    });

    res.json({
      ok: true,
      entry: data.entry,
      duplicate: Boolean(data.duplicate)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.delete("/api/entries/:id", async (req, res) => {
  try {
    const id = req.params.id;

    const data = await callGoogle("delete", {
      id
    });

    res.json({
      ok: true,
      id,
      deleted: data.deleted
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.post("/api/entries/:id/delete", async (req, res) => {
  try {
    const id = req.params.id;

    const data = await callGoogle("delete", {
      id
    });

    res.json({
      ok: true,
      id,
      deleted: data.deleted
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

// Verificação do webhook do WhatsApp Cloud API
app.get("/webhook/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// Recebimento do WhatsApp Cloud API
app.post("/webhook/whatsapp", async (req, res) => {
  try {
    const body = req.body;

    const value = body?.entry?.[0]?.changes?.[0]?.value;
    const messages = value?.messages || [];

    if (!messages.length) {
      return res.status(200).json({
        ok: true,
        ignored: true,
        reason: "Nenhuma mensagem encontrada."
      });
    }

    const saved = [];

    for (const msg of messages) {
      const from = msg.from;
      const text =
        msg?.text?.body ||
        msg?.button?.text ||
        msg?.interactive?.button_reply?.title ||
        msg?.interactive?.list_reply?.title ||
        "";

      if (!text.trim()) continue;

      const entry = buildEntry({
        text,
        originalText: text,
        source: "whatsapp",
        raw: msg
      });

      const data = await callGoogle("append", {
        entry
      });

      saved.push({
        id: data.entry?.id || entry.id,
        duplicate: Boolean(data.duplicate)
      });

      await sendWhatsAppConfirmation(from, text);
    }

    res.status(200).json({
      ok: true,
      saved
    });
  } catch (err) {
    console.error("Erro no webhook WhatsApp:", err);
    res.status(200).json({
      ok: false,
      error: err.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Radar de Vida rodando na porta ${PORT}`);
});
