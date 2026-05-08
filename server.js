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
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.4-mini";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";
const WHATSAPP_GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || "v23.0";
const META_APP_SECRET = process.env.META_APP_SECRET || "";
const SEND_WHATSAPP_CONFIRMATION = String(process.env.SEND_WHATSAPP_CONFIRMATION || "true") === "true";
const DB_FILE = path.resolve(__dirname, process.env.DB_FILE || "./data/radar-db.json");

const app = express();

// Precisamos do raw body para validação opcional da assinatura Meta.
app.use(express.json({
  limit: "2mb",
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

app.use(cors());
app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(morgan("dev"));
app.use(express.static(path.join(__dirname, "public")));

ensureDB();

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "Radar de Vida WhatsApp Webhook",
    version: "0.1.0",
    time: new Date().toISOString(),
    openaiConfigured: Boolean(OPENAI_API_KEY),
    whatsappConfigured: Boolean(WHATSAPP_TOKEN && WHATSAPP_PHONE_NUMBER_ID)
  });
});

/**
 * Verificação do webhook pela Meta.
 * A Meta chama GET /webhook/whatsapp?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
 */
app.get("/webhook/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado pela Meta.");
    return res.status(200).send(challenge);
  }

  console.warn("Falha na verificação do webhook:", { mode, token });
  return res.sendStatus(403);
});

/**
 * Recebimento real dos eventos WhatsApp.
 */
app.post("/webhook/whatsapp", async (req, res) => {
  // Responda rápido para a Meta. O processamento é feito logo após salvar o payload.
  try {
    if (!isValidMetaSignature(req)) {
      console.warn("Assinatura Meta inválida. Configure META_APP_SECRET ou verifique o app secret.");
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

/**
 * Endpoint para testes manuais sem WhatsApp.
 */
app.post("/api/test-message", async (req, res) => {
  try {
    const text = String(req.body?.text || "").trim();
    const from = String(req.body?.from || "teste-local");
    const name = String(req.body?.name || "Usuário Teste");

    if (!text) return res.status(400).json({ error: "Campo text é obrigatório." });

    const record = await processIncomingMessage({
      id: "local_" + uid(),
      from,
      name,
      text,
      timestamp: Math.floor(Date.now() / 1000),
      type: "text",
      source: "api_test"
    }, { source: "api_test" });

    res.json({ ok: true, record });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/records", (req, res) => {
  const db = readDB();
  res.json({
    ok: true,
    records: db.records.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)),
    emergentCategories: calculateEmergentCategories(db.records),
    patterns: calculatePatterns(db.records)
  });
});

app.get("/api/records/:id", (req, res) => {
  const db = readDB();
  const record = db.records.find(r => r.id === req.params.id);
  if (!record) return res.status(404).json({ error: "Registro não encontrado." });
  res.json({ ok: true, record });
});

app.delete("/api/records/:id", (req, res) => {
  const db = readDB();
  const before = db.records.length;
  db.records = db.records.filter(r => r.id !== req.params.id);
  writeDB(db);
  res.json({ ok: true, deleted: before - db.records.length });
});

app.delete("/api/records", (req, res) => {
  const db = readDB();
  db.records = [];
  writeDB(db);
  res.json({ ok: true });
});

app.get("/api/export", (req, res) => {
  const db = readDB();
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="radar-webhook-backup-${new Date().toISOString().slice(0,10)}.json"`);
  res.send(JSON.stringify(db, null, 2));
});

app.post("/api/analyze", async (req, res) => {
  try {
    const text = String(req.body?.text || "").trim();
    if (!text) return res.status(400).json({ error: "Campo text é obrigatório." });
    const analysis = await analyzeText(text, new Date().toISOString());
    res.json({ ok: true, analysis });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

async function processIncomingMessage(msg, originalPayload) {
  const text = String(msg.text || "").trim();
  if (!text) return null;

  const eventDateTime = msg.timestamp
    ? new Date(Number(msg.timestamp) * 1000).toISOString()
    : new Date().toISOString();

  const analysis = await analyzeText(text, eventDateTime);

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

  const db = readDB();

  // Evita duplicar mensagem quando a Meta reenviar evento.
  if (record.whatsappMessageId && db.records.some(r => r.whatsappMessageId === record.whatsappMessageId)) {
    console.log("Mensagem duplicada ignorada:", record.whatsappMessageId);
    return db.records.find(r => r.whatsappMessageId === record.whatsappMessageId);
  }

  db.records.push(record);
  writeDB(db);

  console.log("Registro salvo:", record.id, record.originalText);

  if (SEND_WHATSAPP_CONFIRMATION && msg.from && WHATSAPP_TOKEN && WHATSAPP_PHONE_NUMBER_ID) {
    const reply = buildWhatsAppConfirmation(analysis);
    await sendWhatsAppText(msg.from, reply);
  }

  return record;
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

        if (message.type === "text") {
          text = message.text?.body || "";
        } else if (message.type === "button") {
          text = message.button?.text || "";
        } else if (message.type === "interactive") {
          text = message.interactive?.button_reply?.title
            || message.interactive?.list_reply?.title
            || "";
        } else {
          // Nesta fase, salvamos apenas um marcador para tipos não-texto.
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
    return { receivedAt: new Date().toISOString() };
  }
}

async function analyzeText(text, eventDateTime) {
  if (!OPENAI_API_KEY) {
    return heuristicAnalysis(text, eventDateTime);
  }

  const schema = getAnalysisSchema();

  const body = {
    model: OPENAI_MODEL,
    input: [
      {
        role: "system",
        content: getSystemPrompt()
      },
      {
        role: "user",
        content: `Data/hora de referência: ${eventDateTime}\nMensagem recebida: ${text}`
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "radar_vida_analysis",
        schema,
        strict: true
      }
    }
  };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error("OpenAI falhou. Usando heurística local.", errText.slice(0, 600));
    const fallback = heuristicAnalysis(text, eventDateTime);
    fallback.insight_imediato = "Análise local usada porque a IA falhou: " + response.status;
    return fallback;
  }

  const data = await response.json();
  let outputText = data.output_text;

  if (!outputText && Array.isArray(data.output)) {
    outputText = data.output
      .flatMap(item => item.content || [])
      .map(c => c.text || c.output_text || "")
      .join("\n");
  }

  if (!outputText) {
    const fallback = heuristicAnalysis(text, eventDateTime);
    fallback.insight_imediato = "Análise local usada porque a IA não retornou texto.";
    return fallback;
  }

  return JSON.parse(outputText);
}

function getSystemPrompt() {
  return `Você é o motor de interpretação do projeto Radar de Vida.

Transforme mensagens livres recebidas por WhatsApp em registros estruturados sobre vida cotidiana: finanças, hábitos, sono, saúde, alimentação, exercício, humor, produtividade, agenda, casa, mobilidade, lazer, estudo, relações sociais e padrões comportamentais.

Regras:
- Separe fatos objetivos, inferências prováveis e hipóteses comportamentais.
- Nunca trate hipótese como certeza.
- Não julgue o usuário.
- Crie categorias emergentes candidatas quando a frase revelar padrão comportamental possível.
- Use português do Brasil.
- Seja objetivo, profundo e prático.
- Não dê diagnóstico médico, psicológico, jurídico ou financeiro definitivo.
- Não dê instruções perigosas.
- Responda exclusivamente em JSON válido conforme o schema.`;
}

function getAnalysisSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      texto_original: { type: "string" },
      resumo_curto: { type: "string" },
      eventos_detectados: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            tipo: { type: "string" },
            categoria_principal: { type: "string" },
            subcategoria: { type: "string" },
            valor: { type: ["number", "null"] },
            moeda: { type: ["string", "null"] },
            quantidade: { type: ["number", "null"] },
            unidade: { type: ["string", "null"] },
            data_evento: { type: ["string", "null"] },
            hora_evento: { type: ["string", "null"] },
            impacto: { type: "string" },
            intensidade: { type: ["string", "null"] },
            fato_ou_inferencia: { type: "string" },
            confianca: { type: "number" }
          },
          required: ["tipo","categoria_principal","subcategoria","valor","moeda","quantidade","unidade","data_evento","hora_evento","impacto","intensidade","fato_ou_inferencia","confianca"]
        }
      },
      tags: { type: "array", items: { type: "string" } },
      contextos: { type: "array", items: { type: "string" } },
      emocoes_detectadas: { type: "array", items: { type: "string" } },
      gatilhos_possiveis: { type: "array", items: { type: "string" } },
      consequencias_possiveis: { type: "array", items: { type: "string" } },
      hipoteses: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            nome: { type: "string" },
            descricao: { type: "string" },
            nivel: { type: "string" },
            confianca: { type: "number" }
          },
          required: ["nome","descricao","nivel","confianca"]
        }
      },
      categorias_emergentes_candidatas: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            nome: { type: "string" },
            categoria_mae: { type: "string" },
            motivo: { type: "string" },
            confianca: { type: "number" }
          },
          required: ["nome","categoria_mae","motivo","confianca"]
        }
      },
      insight_imediato: { type: "string" },
      resposta_whatsapp_sugerida: { type: "string" },
      pergunta_opcional: { type: ["string", "null"] }
    },
    required: [
      "texto_original","resumo_curto","eventos_detectados","tags","contextos",
      "emocoes_detectadas","gatilhos_possiveis","consequencias_possiveis",
      "hipoteses","categorias_emergentes_candidatas","insight_imediato",
      "resposta_whatsapp_sugerida","pergunta_opcional"
    ]
  };
}

function buildWhatsAppConfirmation(analysis) {
  const suggested = String(analysis?.resposta_whatsapp_sugerida || "").trim();
  if (suggested) return clamp(suggested, 600);

  const events = analysis?.eventos_detectados || [];
  const first = events[0];
  const cat = analysis?.categorias_emergentes_candidatas?.[0]?.nome;
  const value = first?.valor ? ` de R$ ${Number(first.valor).toFixed(2).replace(".", ",")}` : "";

  let msg = `Registrado: ${analysis?.resumo_curto || "evento salvo"}${value ? "" : ""}.`;
  if (cat) msg += `\nMapa Vivo: possível “${cat}”.`;
  return clamp(msg, 600);
}

async function sendWhatsAppText(to, text) {
  const url = `https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const body = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: {
      preview_url: false,
      body: text
    }
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${WHATSAPP_TOKEN}`,
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
}

function isValidMetaSignature(req) {
  // Em desenvolvimento, sem app secret, não bloqueamos.
  if (!META_APP_SECRET) return true;

  const signature = req.headers["x-hub-signature-256"];
  if (!signature || !String(signature).startsWith("sha256=")) return false;

  const expected = "sha256=" + crypto
    .createHmac("sha256", META_APP_SECRET)
    .update(req.rawBody)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

function heuristicAnalysis(text, eventDateTime) {
  const n = normalize(text);
  const values = extractMoney(text);
  const eventos = [];
  const tags = [];
  const contextos = [];
  const emocoes = [];
  const gatilhos = [];
  const consequencias = [];
  const hipoteses = [];
  const emergentes = [];

  const has = (...words) => words.some(w => n.includes(normalize(w)));

  if (values.length && has("gastei","paguei","comprei","pix","ifood","uber","mercado","almoço","almoco","jantar","lanche","gasolina","combustivel")) {
    let cat = "despesa";
    let sub = "geral";
    if (has("ifood","delivery","pizza","hamburguer","jantar","almoço","almoco","lanche","cafe","restaurante")) {
      cat = "alimentacao";
      sub = has("ifood","delivery") ? "delivery" : "refeicao";
    } else if (has("uber","99","gasolina","combustivel","estacionamento")) {
      cat = "mobilidade";
      sub = has("uber","99") ? "app_transporte" : "combustivel_ou_transporte";
    } else if (has("remedio","farmacia","medico","consulta","exame")) {
      cat = "saude";
      sub = "saude";
    } else if (has("energia","agua","internet","aluguel","condominio","gás","gas")) {
      cat = "casa";
      sub = "conta_domestica";
    }

    eventos.push(evt("financeiro", cat, sub, values[0], "BRL", null, null, eventDateTime, "neutro", null, "fato", .82));
  }

  if (values.length && has("recebi","ganhei","honorario","honorários","cliente","salario","salário","vendi")) {
    eventos.push(evt("receita", "receita", has("cliente","honorario","honorários") ? "profissional" : "geral", values[0], "BRL", null, null, eventDateTime, "positivo", null, "fato", .85));
  }

  if (has("treinei","caminhei","corrida","corri","academia","alonguei","pedalei")) {
    eventos.push(evt("habito", "exercicio", detectExerciseSub(n), null, null, extractNumberBeforeUnit(text, ["min","minutos","h","hora","horas"]), "tempo", eventDateTime, "positivo", null, "fato", .78));
    tags.push("movimento", "exercicio");
  }

  if (has("dormi","sono","acordei","insônia","insonia")) {
    const impact = has("mal","ruim","pouco","insônia","insonia","cansado") ? "negativo" : "positivo";
    eventos.push(evt("sono", "sono", impact === "negativo" ? "sono_ruim" : "sono_bom", null, null, extractSleepHours(text), "horas", eventDateTime, impact, null, "fato", .72));
    tags.push(impact === "negativo" ? "sono_ruim" : "sono_bom");
  }

  const emotionMap = [
    ["ansioso", "ansiedade"], ["ansiedade", "ansiedade"], ["irritado", "irritacao"],
    ["triste", "tristeza"], ["feliz", "alegria"], ["cansado", "cansaco"],
    ["exausto", "exaustao"], ["sem energia", "baixa_energia"], ["estressado", "estresse"],
    ["calmo", "calma"], ["leve", "leveza"], ["orgulho", "orgulho"]
  ];

  for (const [w,e] of emotionMap) {
    if (n.includes(normalize(w)) && !emocoes.includes(e)) emocoes.push(e);
  }

  if (emocoes.length) {
    eventos.push(evt("emocional", "estado_emocional", emocoes[0], null, null, null, null, eventDateTime, ["alegria","calma","leveza","orgulho"].includes(emocoes[0]) ? "positivo" : "alerta", detectIntensity(n), "inferencia", .70));
  }

  if (has("reuniao","reunião","audiencia","audiência","trabalho","cliente","prazo")) {
    contextos.push("trabalho");
    if (has("reuniao","reunião")) gatilhos.push("reuniao");
    if (has("audiencia","audiência")) gatilhos.push("audiencia");
  }

  if (has("cansado","exausto","sem energia","morto")) {
    tags.push("cansaco", "baixa_energia");
    if (has("ifood","delivery","jantar","pizza","hamburguer")) {
      emergentes.push(catCand("delivery por exaustão", "alimentacao", "A frase associa alimentação por conveniência a cansaço ou baixa energia.", .74));
      hipoteses.push(hyp("alimentacao_por_exaustao", "Possível uso de delivery/refeição pronta como resposta a cansaço.", "hipotese_comportamental", .70));
    }
  }

  if (has("atrasado","perdi a hora","acordei tarde") && has("uber","taxi","99")) {
    emergentes.push(catCand("custo do atraso", "mobilidade", "A frase indica despesa gerada por atraso ou quebra da rotina matinal.", .78));
    hipoteses.push(hyp("custo_da_desorganizacao", "Possível custo financeiro causado por atraso ou falta de planejamento.", "hipotese_comportamental", .72));
    tags.push("atraso", "desorganizacao");
  }

  if (has("de novo","novamente","outra vez")) tags.push("recorrencia");
  if (has("pressa","sem tempo","corrido")) { tags.push("pressa"); gatilhos.push("falta_de_tempo"); }
  if (has("melhor","fiquei melhor","me ajudou")) consequencias.push("melhora_percebida");
  if (has("pior","irritado","ansioso")) consequencias.push("piora_ou_alerta_percebido");

  if (!eventos.length) {
    eventos.push(evt("livre", "registro_livre", "anotacao", null, null, null, null, eventDateTime, "neutro", null, "fato", .55));
  }

  return {
    texto_original: text,
    resumo_curto: buildShortSummary(eventos, text),
    eventos_detectados: eventos,
    tags: unique(tags),
    contextos: unique(contextos),
    emocoes_detectadas: unique(emocoes),
    gatilhos_possiveis: unique(gatilhos),
    consequencias_possiveis: unique(consequencias),
    hipoteses,
    categorias_emergentes_candidatas: emergentes,
    insight_imediato: localInsight(eventos, unique(tags), emergentes),
    resposta_whatsapp_sugerida: buildLocalReply(eventos, emergentes),
    pergunta_opcional: null
  };
}

function evt(tipo, categoria, subcategoria, valor, moeda, quantidade, unidade, dt, impacto, intensidade, foi, conf) {
  const d = new Date(dt);
  return {
    tipo,
    categoria_principal: categoria,
    subcategoria,
    valor,
    moeda,
    quantidade,
    unidade,
    data_evento: Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0,10),
    hora_evento: Number.isNaN(d.getTime()) ? null : d.toTimeString().slice(0,5),
    impacto,
    intensidade,
    fato_ou_inferencia: foi,
    confianca: conf
  };
}

function hyp(nome, descricao, nivel, confianca) {
  return { nome, descricao, nivel, confianca };
}

function catCand(nome, categoria_mae, motivo, confianca) {
  return { nome, categoria_mae, motivo, confianca };
}

function extractMoney(text) {
  const out = [];
  const re = /(?:r\$)?\s*(\d{1,6}(?:[.,]\d{1,2})?)\s*(?:r\$|\breais\b|\breal\b)?/gi;
  let m;
  while ((m = re.exec(text))) {
    const v = Number.parseFloat(m[1].replace(".", "").replace(",", "."));
    if (!Number.isNaN(v) && v > 0 && v < 1000000) out.push(v);
  }
  return out;
}

function extractNumberBeforeUnit(text, units) {
  const unitRe = units.join("|");
  const re = new RegExp("(\\d+(?:[\\.,]\\d+)?)\\s*(?:" + unitRe + ")", "i");
  const m = text.match(re);
  return m ? Number.parseFloat(m[1].replace(",", ".")) : null;
}

function extractSleepHours(text) {
  const n = normalize(text);
  const m = n.match(/dormi\s+(\d+(?:[.,]\d+)?)\s*h/);
  return m ? Number.parseFloat(m[1].replace(",", ".")) : null;
}

function detectExerciseSub(n) {
  if (n.includes("caminh")) return "caminhada";
  if (n.includes("academia")) return "academia";
  if (n.includes("corr")) return "corrida";
  if (n.includes("along")) return "alongamento";
  if (n.includes("pedal") || n.includes("bike")) return "bicicleta";
  return "exercicio";
}

function detectIntensity(n) {
  if (n.includes("muito") || n.includes("demais") || n.includes("exausto") || n.includes("forte")) return "alta";
  if (n.includes("pouco") || n.includes("leve")) return "baixa";
  return "media";
}

function buildShortSummary(eventos, text) {
  const ev = eventos[0];
  if (!ev) return "Registro livre.";
  if (ev.tipo === "financeiro") return `Despesa em ${ev.categoria_principal}/${ev.subcategoria}${ev.valor ? " de R$ " + Number(ev.valor).toFixed(2).replace(".", ",") : ""}.`;
  if (ev.tipo === "receita") return `Receita registrada${ev.valor ? " de R$ " + Number(ev.valor).toFixed(2).replace(".", ",") : ""}.`;
  if (ev.tipo === "habito") return `Hábito registrado: ${ev.categoria_principal}/${ev.subcategoria}.`;
  if (ev.tipo === "emocional") return `Estado emocional detectado: ${ev.subcategoria}.`;
  return text.slice(0, 90);
}

function localInsight(eventos, tags, emergentes) {
  if (emergentes.length) return `Este registro sugere uma categoria emergente: ${emergentes[0].nome}.`;
  if (tags.includes("pressa")) return "O registro envolve pressa ou falta de tempo; isso pode ser acompanhado como fator de rotina.";
  if (tags.includes("cansaco")) return "O registro envolve cansaço; vale observar se ele se relaciona com gastos, alimentação ou produtividade.";
  if (eventos.some(e => e.tipo === "financeiro")) return "Registro financeiro salvo. Com repetição, o sistema poderá separar gasto necessário, planejado, social ou comportamental.";
  return "Registro salvo como pista de rotina para análise futura.";
}

function buildLocalReply(eventos, emergentes) {
  const main = eventos[0];
  let msg = "Registrado.";
  if (main?.tipo === "financeiro") msg = `Registrado: despesa em ${main.categoria_principal}${main.valor ? " de R$ " + Number(main.valor).toFixed(2).replace(".", ",") : ""}.`;
  else if (main?.tipo === "receita") msg = `Registrado: receita${main.valor ? " de R$ " + Number(main.valor).toFixed(2).replace(".", ",") : ""}.`;
  else if (main?.tipo === "habito") msg = `Registrado: hábito de ${main.subcategoria}.`;
  else if (main?.tipo === "emocional") msg = `Registrado: estado emocional — ${main.subcategoria}.`;
  if (emergentes[0]) msg += `\nMapa Vivo: possível “${emergentes[0].nome}”.`;
  return msg;
}

function calculateEmergentCategories(records) {
  const map = new Map();

  for (const r of records) {
    const cands = r.analysis?.categorias_emergentes_candidatas || [];
    for (const c of cands) {
      const key = normalizeKey(c.nome);
      if (!map.has(key)) {
        map.set(key, {
          id: "cat_" + uid(),
          nome: c.nome,
          categoria_mae: c.categoria_mae || "livre",
          motivo: c.motivo || "",
          ocorrencias: 0,
          confianca_media: 0,
          evidencias: [],
          status: "candidata"
        });
      }
      const item = map.get(key);
      item.ocorrencias++;
      item.confianca_media += Number(c.confianca || 0.5);
      item.evidencias.push({ recordId: r.id, text: r.originalText, date: r.eventDateTime });
    }
  }

  return [...map.values()].map(c => {
    c.confianca_media = c.ocorrencias ? c.confianca_media / c.ocorrencias : 0;
    c.status = c.ocorrencias >= 5 ? "consolidada" : c.ocorrencias >= 2 ? "ativa" : "candidata";
    return c;
  }).sort((a,b) => b.ocorrencias - a.ocorrencias);
}

function calculatePatterns(records) {
  const patternMap = new Map();

  for (const r of records) {
    const a = r.analysis || {};
    const tags = a.tags || [];
    const triggers = a.gatilhos_possiveis || [];
    const emotions = a.emocoes_detectadas || [];
    const events = a.eventos_detectados || [];

    const combos = [];
    if (tags.includes("cansaco") && events.some(e => e.categoria_principal === "alimentacao")) combos.push("alimentação associada a cansaço");
    if (tags.includes("atraso") && events.some(e => e.tipo === "financeiro")) combos.push("custo financeiro do atraso");
    if (triggers.includes("reuniao") && emotions.length) combos.push("emoção após reunião");
    if (events.some(e => e.tipo === "sono" && e.impacto === "negativo") && tags.includes("pressa")) combos.push("sono ruim e pressa");
    if (events.some(e => e.tipo === "habito" && e.categoria_principal === "exercicio") && (a.consequencias_possiveis || []).includes("melhora_percebida")) combos.push("exercício restaurador");

    for (const name of combos) {
      if (!patternMap.has(name)) {
        patternMap.set(name, { id: "pat_" + uid(), nome: name, ocorrencias: 0, evidencias: [], confianca: .55 });
      }
      const p = patternMap.get(name);
      p.ocorrencias++;
      p.evidencias.push({ recordId: r.id, text: r.originalText, date: r.eventDateTime });
    }
  }

  return [...patternMap.values()]
    .map(p => ({ ...p, confianca: Math.min(.95, .45 + p.ocorrencias * .12), status: p.ocorrencias >= 3 ? "forte" : "inicial" }))
    .sort((a,b) => b.ocorrencias - a.ocorrencias);
}

function saveRawWebhook(payload) {
  const dir = path.dirname(DB_FILE);
  const rawDir = path.join(dir, "raw-webhooks");
  fs.mkdirSync(rawDir, { recursive: true });
  const name = new Date().toISOString().replace(/[:.]/g, "-") + "_" + uid() + ".json";
  fs.writeFileSync(path.join(rawDir, name), JSON.stringify(payload, null, 2), "utf-8");
}

function ensureDB() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    writeDB({
      version: "0.1.0",
      createdAt: new Date().toISOString(),
      records: []
    });
  }
}

function readDB() {
  ensureDB();
  return JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
}

function writeDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf-8");
}

function normalize(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function normalizeKey(s) {
  return normalize(s).replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function unique(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function clamp(s, max) {
  s = String(s || "");
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

app.listen(PORT, () => {
  console.log(`Radar de Vida Webhook rodando em http://localhost:${PORT}`);
  console.log(`Webhook de verificação: GET http://localhost:${PORT}/webhook/whatsapp`);
  console.log(`Webhook receptor: POST http://localhost:${PORT}/webhook/whatsapp`);
});
