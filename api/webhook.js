// /api/webhook.js
// ✅ WhatsApp Cloud API webhook (Vercel) + Mentor (OpenAI) + Calculadora + Áudio (transcrição)

const sessions = new Map(); // from -> { history: [], state: {...}, _lastTs }
const processed = new Map(); // msgId -> timestamp

/* =========================
   Utils básicos
   ========================= */
function cleanupMap(map, ttlMs) {
  const now = Date.now();
  for (const [k, v] of map.entries()) if (now - v > ttlMs) map.delete(k);
}

function cleanupSessions(ttlMs = 6 * 60 * 60 * 1000) {
  const now = Date.now();
  for (const [k, v] of sessions.entries()) {
    const last = v?._lastTs || 0;
    if (last && now - last > ttlMs) sessions.delete(k);
  }
}

function seenRecently(msgId, ttlMs = 10 * 60 * 1000) {
  if (!msgId) return false;
  cleanupMap(processed, ttlMs);
  const now = Date.now();
  const ts = processed.get(msgId);
  if (ts && now - ts < ttlMs) return true;
  processed.set(msgId, now);
  return false;
}

function nowInSaoPaulo() {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function humanDelayMs(text) {
  const len = (text || "").length;
  const base = 700;
  const perChar = 8;
  const jitter = Math.floor(Math.random() * 600);
  const ms = base + len * perChar + jitter;
  return Math.min(4500, Math.max(550, ms));
}

/**
 * Envia respostas longas em várias partes (sem “travamento”).
 */
function splitMessageSmart(text, maxParts = 6) {
  const t = (text || "").trim();
  if (!t) return ["..."];

  const MAX = 650;
  if (t.length <= MAX) return [t];

  const lines = t.split("\n").map((s) => s.trim()).filter(Boolean);
  const parts = [];
  let buf = "";

  const pushBuf = () => {
    if (buf.trim()) parts.push(buf.trim());
    buf = "";
  };

  for (const line of lines) {
    if (line.length > MAX) {
      const chunks = line.split(/(?<=[.!?])\s+/);
      for (const c of chunks) {
        if ((buf + " " + c).trim().length > MAX) pushBuf();
        buf = (buf ? buf + " " : "") + c;
      }
      continue;
    }
    if ((buf + "\n" + line).trim().length > MAX) pushBuf();
    buf = buf ? buf + "\n" + line : line;
  }
  pushBuf();

  const finalParts = parts.slice(0, maxParts);
  if (parts.length > maxParts) {
    finalParts[finalParts.length - 1] =
      finalParts[finalParts.length - 1].trim() + "\n\n(Se quiser, eu continuo 🙂)";
  }

  if (finalParts.length > 1) {
    return finalParts.map((p, i) => `(${i + 1}/${finalParts.length})\n${p}`);
  }
  return finalParts;
}

function assertEnv() {
  const needed = ["VERIFY_TOKEN", "WHATSAPP_TOKEN", "PHONE_NUMBER_ID", "OPENAI_API_KEY"];
  const missing = needed.filter((k) => !process.env[k]);
  if (missing.length) throw new Error("Missing env vars: " + missing.join(", "));
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function sendWhatsAppText({ to, bodyText, trace }) {
  const url = `https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/messages`;

  const r = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: bodyText },
      }),
    },
    12000
  );

  const dataText = await r.text();
  if (!r.ok) {
    console.log("❌ WhatsApp send error:", { trace, status: r.status, dataText: dataText.slice(0, 800) });
  } else {
    console.log("✅ WhatsApp sent:", { trace, status: r.status });
  }
  return { ok: r.ok, status: r.status, dataText };
}

function ensureSession(from) {
  if (!sessions.has(from)) {
    sessions.set(from, {
      history: [],
      state: {
        mode: "mentor", // "mentor" | "calc"
        calc: null,
        pendingLong: null, // { fullText, parts[] }
        pendingCalcConfirm: false, // aguardando "1/2" ou "sim/não"
      },
    });
  }
  const sess = sessions.get(from);
  sess._lastTs = Date.now();
  return sess;
}

/* =========================
   Feedback de input inválido (evita “silêncio”/travamento)
   ========================= */
async function sendCalcInvalid({ to, trace, msg, prompt }) {
  const text =
`${msg}

📌 Exemplos válidos:
- 30cm
- 0,8m
- 5mm
- 30x10x0,5cm

${prompt}`;
  const parts = splitMessageSmart(text, 4);
  for (const p of parts) {
    await sleep(humanDelayMs(p));
    await sendWhatsAppText({ to, bodyText: p, trace });
  }
}

/* =========================
   Detector de intenção da calculadora
   ========================= */
function normalizeLoose(s) {
  return (s || "")
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function isCalcIntent(text) {
  const s = normalizeLoose(text);

  const keywords = [
    "calculadora",
    "calc",
    "calcular",
    "calculo",
    "cálculo",
    "volume",
    "quantos kg",
    "quantas gramas",
    "quantos g",
    "quanto de resina",
    "quantidade de resina",
    "resina precisa",
    "quanto preciso de resina",
    "quanto endurecedor",
    "mistura",
    "proporcao",
    "proporção",
    "litros",
    "ml",
  ];

  const hasDimsInline = /(\d+([.,]\d+)?x){2}\d+([.,]\d+)?(mm|cm|m)?\b/i.test(text);
  if (hasDimsInline) return true;

  return keywords.some((k) => s.includes(normalizeLoose(k)));
}

function isYes(text) {
  const s = normalizeLoose(text);
  return ["1", "sim", "s", "claro", "bora", "vamos", "quero", "pode", "ok", "beleza"].includes(s);
}

function isNo(text) {
  const s = normalizeLoose(text);
  return ["2", "nao", "não", "n", "agora nao", "agora não", "depois", "não quero"].includes(s);
}

/* =========================
   CALCULADORA
   ========================= */
const DENSITY_KG_PER_L = 1.10;
const PI = Math.PI;

function parseLengthToCm(input) {
  const t = (input || "").toString().trim().toLowerCase().replace(",", ".");
  const m = t.match(/(\d+(\.\d+)?)(mm|cm|m)?/);
  if (!m) return null;
  const val = Number(m[1]);
  if (!Number.isFinite(val) || val <= 0) return null;
  const unit = (m[3] || "cm").toLowerCase();
  if (unit === "m") return val * 100;
  if (unit === "mm") return val / 10;
  return val;
}

function parseWeightToG(input) {
  const t = (input || "").toString().trim().toLowerCase().replace(",", ".");
  const m = t.match(/(\d+(\.\d+)?)(kg|g)?/);
  if (!m) return null;
  const val = Number(m[1]);
  if (!Number.isFinite(val) || val <= 0) return null;
  const unit = (m[3] || "g").toLowerCase();
  if (unit === "kg") return val * 1000;
  return val;
}

function parseKitWeights(text) {
  const t = (text || "").toString().trim().toLowerCase().replace(",", ".");
  const matches = [...t.matchAll(/(\d+(\.\d+)?)(kg|g)\b/g)];
  if (matches.length >= 2) {
    const resinG = parseWeightToG(matches[0][0]);
    const hardG = parseWeightToG(matches[1][0]);
    if (resinG && hardG) return { resinG, hardG };
  }
  return null;
}

// 30x10x0,5cm / 3x0,9x0,02m / 300x90x2 (assume cm)
function parseDims3Inline(text) {
  const raw = (text || "").toString().trim().toLowerCase().replace(/\s+/g, "");
  const t = raw.replace(",", ".");

  let unit = null;
  const unitMatch = t.match(/(mm|cm|m)$/);
  if (unitMatch) unit = unitMatch[1];

  const core = unit ? t.slice(0, -unit.length) : t;
  const parts = core.split("x").filter(Boolean);
  if (parts.length !== 3) return null;

  const nums = parts.map((p) => {
    const n = Number(p);
    return Number.isFinite(n) ? n : null;
  });
  if (nums.some((n) => n == null || n <= 0)) return null;

  const toCm = (val) => {
    if (unit === "m") return val * 100;
    if (unit === "mm") return val / 10;
    return val;
  };

  return { c_cm: toCm(nums[0]), l_cm: toCm(nums[1]), a_cm: toCm(nums[2]) };
}

function litersFromCm3(cm3) {
  return cm3 / 1000;
}
function kgFromLiters(liters) {
  return liters * DENSITY_KG_PER_L;
}
function formatKg(kg) {
  return `${kg.toFixed(2).replace(".", ",")} kg`;
}
function formatG(g) {
  return `${Math.round(g)} g`;
}

function computeVolumeLiters(calc) {
  const shape = calc.shape;

  if (shape === "retangulo") {
    const cm3 = calc.c_cm * calc.l_cm * calc.a_cm;
    return litersFromCm3(cm3);
  }
  if (shape === "cilindro") {
    const r = calc.diam_cm / 2;
    const cm3 = PI * r * r * calc.a_cm;
    return litersFromCm3(cm3);
  }
  if (shape === "triangular") {
    const cm3 = (calc.base_cm * calc.alttri_cm / 2) * calc.comp_cm;
    return litersFromCm3(cm3);
  }
  if (shape === "camada") {
    const cm3 = (calc.c_cm * calc.l_cm) * calc.esp_cm;
    return litersFromCm3(cm3);
  }
  return null;
}

function buildCalcMenu() {
  return (
`🧮 Calculadora exclusiva (Universidade da Resina)

Escolhe o formato:
1) Retângulo (C x L x A)
2) Cilindro (diâmetro x altura)
3) Prisma triangular (base x altura do triângulo x comprimento)
4) Camada superficial (C x L x espessura)

📌 Dica: no retângulo você pode mandar tudo em uma linha:
"30x10x0,5cm" ou "3x0,9x0,02m"

Responde só com o número (1 a 4) 🙂`
  );
}

function calcNextPrompt(calc) {
  if (!calc.shape) return buildCalcMenu();

  if (calc.shape === "retangulo") {
    if (!calc.inlineTried) {
      return `Me manda as medidas. Pode ser assim:
- Tudo junto: 30x10x0,5cm
ou
- Separado: comprimento (ex: 30cm ou 3m)`;
    }
    if (calc.c_cm == null) return "Comprimento? (ex: 30cm ou 3m)";
    if (calc.l_cm == null) return "Largura? (ex: 10cm ou 0,8m)";
    if (calc.a_cm == null) return "Altura/espessura do vazamento? (ex: 0,5cm ou 5mm)";
  }

  if (calc.shape === "cilindro") {
    if (calc.diam_cm == null) return "Diâmetro? (ex: 10cm ou 0,3m)";
    if (calc.a_cm == null) return "Altura/profundidade? (ex: 3cm ou 30mm)";
  }

  if (calc.shape === "triangular") {
    if (calc.base_cm == null) return "Base do triângulo? (ex: 12cm)";
    if (calc.alttri_cm == null) return "Altura do triângulo? (ex: 8cm)";
    if (calc.comp_cm == null) return "Comprimento do prisma? (ex: 40cm ou 1,2m)";
  }

  if (calc.shape === "camada") {
    if (calc.c_cm == null) return "Comprimento da área? (ex: 1m ou 30cm)";
    if (calc.l_cm == null) return "Largura da área? (ex: 0,5m ou 20cm)";
    if (calc.esp_cm == null) return "Espessura da camada? (ex: 1mm, 2mm ou 0,2cm)";
  }

  if (!calc.kit) {
    return (
`Agora me diz o KIT que você comprou (pra eu achar a proporção certinha):

➡️ Quanto veio de RESINA e quanto veio de ENDURECEDOR?
Exemplos:
- "1kg e 500g"
- "1000g e 120g"
- "1,2kg e 300g"`
    );
  }

  return null;
}

function finishCalcMessage(calc) {
  const liters = computeVolumeLiters(calc);
  const kgTotal = kgFromLiters(liters);
  const gTotal = kgTotal * 1000;

  const resinParts = calc.kit.resinG;
  const hardParts = calc.kit.hardG;
  const totalParts = resinParts + hardParts;

  const resin_g = gTotal * (resinParts / totalParts);
  const hard_g = gTotal * (hardParts / totalParts);

  const ratioApprox = resinParts / hardParts;
  const ratioText = ratioApprox > 0 ? `≈ ${ratioApprox.toFixed(2).replace(".", ",")}:1` : "—";

  return (
`✅ Cálculo pronto

⚖️ Total aproximado: ${formatKg(kgTotal)} (${formatG(gTotal)})

🧪 Mistura (baseado no seu KIT):
- Resina: ${formatG(resin_g)}
- Endurecedor: ${formatG(hard_g)}
(razão RESINA:ENDURECEDOR ${ratioText})

💡 Dica: se for madeira (selagem fraca, frestas, perda no copo), faz ~10% a mais pra garantir. Se for molde silicone bem fechado, dá pra seguir mais “no alvo”.

Quer calcular outra peça? É só me dizer "quero calcular" 🙂`
  );
}

/* =========================
   MODO “PLANO” (respostas longas)
   ========================= */
function isContinueText(t) {
  const s = normalizeLoose(t);
  return ["sim", "s", "continua", "continue", "manda", "pode mandar", "segue", "ok", "beleza", "vai", "vamos"].includes(s);
}

function looksLikePlanRequest(t) {
  const s = normalizeLoose(t);
  return (
    s.includes("plano") ||
    s.includes("passo a passo") ||
    s.includes("checklist") ||
    s.includes("guia completo") ||
    s.includes("bem detalhado") ||
    s.includes("estrategia") ||
    s.includes("cronograma") ||
    s.includes("roteiro") ||
    s.includes("me da um plano") ||
    s.includes("me de um plano") ||
    s.includes("me da um guia") ||
    s.includes("me de um guia")
  );
}

/* =========================
   ✅ ÁUDIO: WhatsApp -> baixar mídia -> transcrever (OpenAI) -> virar texto
   ========================= */
async function getWhatsAppMediaMeta(mediaId, trace) {
  const url = `https://graph.facebook.com/v22.0/${mediaId}`;
  const r = await fetchWithTimeout(
    url,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
    },
    12000
  );

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.log("❌ Media meta error:", { trace, status: r.status, data: JSON.stringify(data).slice(0, 900) });
    return null;
  }
  // esperado: { url, mime_type, sha256, file_size, id }
  return data;
}

async function downloadWhatsAppMediaFile(mediaUrl, trace) {
  const r = await fetchWithTimeout(
    mediaUrl,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
    },
    20000
  );

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    console.log("❌ Media download error:", { trace, status: r.status, body: t.slice(0, 500) });
    return null;
  }
  const arrayBuffer = await r.arrayBuffer();
  const contentType = r.headers.get("content-type") || "application/octet-stream";
  return { arrayBuffer, contentType };
}

async function transcribeWithOpenAI({ arrayBuffer, contentType, trace }) {
  // Modelo de transcrição (padrão: whisper-1)
  const model = process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1";

  const form = new FormData();
  const blob = new Blob([arrayBuffer], { type: contentType });

  // filename ajuda a API a aceitar melhor
  const filename = contentType.includes("ogg") ? "audio.ogg" : "audio.bin";

  form.append("model", model);
  form.append("file", blob, filename);
  // form.append("language", "pt"); // opcional (se quiser travar pt)

  const r = await fetchWithTimeout(
    "https://api.openai.com/v1/audio/transcriptions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: form,
    },
    25000
  );

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.log("❌ OpenAI transcription error:", {
      trace,
      status: r.status,
      data: JSON.stringify(data).slice(0, 900),
    });
    return null;
  }

  const text = (data?.text || "").trim();
  return text || null;
}

async function transcribeWhatsAppAudio({ mediaId, trace }) {
  const meta = await getWhatsAppMediaMeta(mediaId, trace);
  if (!meta?.url) return null;

  const file = await downloadWhatsAppMediaFile(meta.url, trace);
  if (!file?.arrayBuffer) return null;

  const transcript = await transcribeWithOpenAI({
    arrayBuffer: file.arrayBuffer,
    contentType: meta.mime_type || file.contentType,
    trace,
  });

  return transcript;
}

/* =========================
   AGENTE MENTOR (OpenAI)
   ========================= */
async function getAIReply({ history, userText, trace }) {
  const spTime = nowInSaoPaulo();

  const system = `
Você é o Assistente Oficial da UNIVERSIDADE DA RESINA, do professor Matheus.
Você é um mentor técnico + amigo no WhatsApp: acolhedor, direto, prático e detalhista quando necessário.

TOM
- Pode usar "meu amigo/minha amiga" às vezes (não toda hora).
- Emojis com intenção (0–2 por mensagem).
- Estilo WhatsApp: curto por padrão. Se pedirem, aprofunda.

PRINCÍPIOS
- Madeira é viva (umidade/temperatura). Resina é química (proporção/mistura/espessura/ambiente).
- Pressa é inimiga da resina.
- Teste antes da peça final.
- Ambiente controlado = previsibilidade.
- 90% do acabamento nasce antes do lixamento.

BASE TÉCNICA (resumo)
- Resina baixa: selagem/camadas finas; não usar em grandes volumes.
- Média: versátil (tábuas/bandejas/peças médias).
- Alta: vazamentos altos (mesas); respeitar altura máxima por camada e tempo entre camadas.
- Madeira ideal 8–12% umidade; madeira úmida causa bolhas/trincas/descolamento.
- Selagem reduz bolhas e economiza resina.
- Ambiente ideal 20–25°C; evitar vento/poeira/sol direto; base nivelada.
- Mistura em peso, devagar 3–5min raspando laterais/fundo; trocar de recipiente ajuda.
- Pigmento: pouco; excesso pode prejudicar cura.
- Bolhas: selagem + soprador rápido nos primeiros minutos; bolha interna não corrige depois.
- Lixamento comum: 80/120 -> 220/320 -> 400/600 -> 800 a 2000; polimento depois.
- Segurança: luvas, máscara, óculos, ventilação, longe de alimentos/crianças.

REGRA IMPORTANTE SOBRE CÁLCULOS
- Se o usuário pedir cálculo de volume/quantidade de resina/quanto vai de resina/endurecedor, NÃO faça conta manual no texto.
- Em vez disso, ofereça a "Calculadora exclusiva da Universidade da Resina" e peça confirmação (sim/não), porque ela calcula certo com densidade e proporção do kit.

PLANOS LONGOS
Quando o usuário pedir um PLANO/GUIA/CHECKLIST longo:
1) responda primeiro com um RESUMO curto (7–10 linhas)
2) finalize com: "Quer que eu detalhe em partes? (sim/continuar)"
Não escreva o plano inteiro de uma vez na primeira resposta.

REGRAS
- Não invente dados específicos de marca/linha. Se precisar, peça rótulo/ficha técnica.
- Quando for recomendação geral, deixe claro ("como regra geral...").
- Termine com UMA pergunta prática que avance o caso.

Horário (SP): ${spTime}
`.trim();

  const payload = {
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages: [
      { role: "system", content: system },
      ...history,
      { role: "user", content: userText },
    ],
    temperature: 0.55,
  };

  const r = await fetchWithTimeout(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
    15000
  );

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.log("❌ OpenAI error:", { trace, status: r.status, data: JSON.stringify(data).slice(0, 900) });
    return "Entendi, meu amigo. Quer usar a Calculadora exclusiva pra eu calcular certinho? (1) Sim (2) Não";
  }

  const reply = data?.choices?.[0]?.message?.content?.trim();
  return reply || "Entendi, meu amigo. Quer usar a Calculadora exclusiva pra eu calcular certinho? (1) Sim (2) Não";
}

/* =========================
   HANDLER
   ========================= */
export default async function handler(req, res) {
  // Verify Meta
  if (req.method === "GET") {
    const mode = req.query?.["hub.mode"];
    const token = req.query?.["hub.verify_token"];
    const challenge = req.query?.["hub.challenge"];
    if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) return res.status(200).send(challenge);
    return res.status(403).send("Forbidden");
  }

  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    assertEnv();

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const value = body?.entry?.[0]?.changes?.[0]?.value;

    if (value?.statuses?.length) return res.status(200).json({ ok: true });

    const msg = value?.messages?.[0];
    if (!msg) return res.status(200).json({ ok: true });

    const from = msg.from;
    const msgId = msg.id;
    const trace = `${from}:${msgId || "noid"}`;

    cleanupMap(processed, 10 * 60 * 1000);
    cleanupSessions();

    if (seenRecently(msgId)) return res.status(200).json({ ok: true });

    if (msg.type === "sticker") return res.status(200).json({ ok: true });

    const sess = ensureSession(from);

    // comando de reset
    if (msg.type === "text" && (msg.text?.body || "").trim().toLowerCase() === "#reset") {
      sessions.delete(from);
      const ok = "Sessão resetada ✅ Pode mandar sua dúvida do zero.";
      await sleep(humanDelayMs(ok));
      await sendWhatsAppText({ to: from, bodyText: ok, trace });
      return res.status(200).json({ ok: true });
    }

    // manter #calc pra debug/teste
    if (msg.type === "text" && (msg.text?.body || "").trim().toLowerCase() === "#calc") {
      sess.state.mode = "calc";
      sess.state.calc = { shape: null, kit: null, inlineTried: false };
      sess.state.pendingCalcConfirm = false;
      const prompt = calcNextPrompt(sess.state.calc);
      await sleep(humanDelayMs(prompt));
      await sendWhatsAppText({ to: from, bodyText: prompt, trace });
      return res.status(200).json({ ok: true });
    }

    // =========
    // ✅ Captura texto do usuário (se vier por áudio, transcreve)
    // =========
    let userText = "";

    if (msg.type === "text") {
      userText = msg.text?.body?.trim() || "";
      if (!userText) return res.status(200).json({ ok: true });
    } else if (msg.type === "audio") {
      // WhatsApp voice note / audio
      const mediaId = msg.audio?.id;
      if (!mediaId) {
        const quick = "Não consegui acessar esse áudio 😅 Me manda em texto rapidinho?";
        await sleep(humanDelayMs(quick));
        await sendWhatsAppText({ to: from, bodyText: quick, trace });
        return res.status(200).json({ ok: true });
      }

      const ack = "Tô ouvindo teu áudio aqui… 🎧";
      await sleep(humanDelayMs(ack));
      await sendWhatsAppText({ to: from, bodyText: ack, trace });

      const transcript = await transcribeWhatsAppAudio({ mediaId, trace });
      if (!transcript) {
        const fail = "Deu ruim pra transcrever esse áudio 😅 Pode mandar de novo (mais pertinho do microfone) ou escrever em texto?";
        await sleep(humanDelayMs(fail));
        await sendWhatsAppText({ to: from, bodyText: fail, trace });
        return res.status(200).json({ ok: true });
      }

      userText = transcript.trim();

      // opcional: guardar no histórico com marca de áudio
      sess.history.push({ role: "user", content: `🗣️ (áudio) ${userText}` });
      if (sess.history.length > 18) sess.history.splice(0, sess.history.length - 18);
    } else {
      // outros tipos (imagem, documento, etc.)
      const quick = "Consigo te ajudar 🙂 Me manda em texto sua dúvida (ou manda um áudio).";
      await sleep(humanDelayMs(quick));
      await sendWhatsAppText({ to: from, bodyText: quick, trace });
      return res.status(200).json({ ok: true });
    }

    // Se tiver “plano em partes” pendente e pedir continuar
    if (sess.state.pendingLong && isContinueText(userText)) {
      const p = sess.state.pendingLong.parts;
      const next = p.splice(0, 2);
      if (!p.length) sess.state.pendingLong = null;

      for (const part of next) {
        await sleep(humanDelayMs(part));
        await sendWhatsAppText({ to: from, bodyText: part, trace });
      }
      if (sess.state.pendingLong) {
        const ask = "Quer que eu continue? (sim/continuar)";
        await sleep(humanDelayMs(ask));
        await sendWhatsAppText({ to: from, bodyText: ask, trace });
      }
      return res.status(200).json({ ok: true });
    }

    // Se o usuário mencionou cálculo e NÃO está no modo calc, oferecer a calculadora
    if (sess.state.mode !== "calc" && isCalcIntent(userText) && !sess.state.pendingCalcConfirm) {
      sess.state.pendingCalcConfirm = true;

      const offer =
`🧮 Quer usar a Calculadora exclusiva da Universidade da Resina?
Ela calcula certinho com densidade (1,10) e com a proporção do seu kit (resina/endurecedor).

1) Sim, quero calcular
2) Não, só uma orientação`;
      await sleep(humanDelayMs(offer));
      await sendWhatsAppText({ to: from, bodyText: offer, trace });
      return res.status(200).json({ ok: true });
    }

    // Se estava aguardando confirmação da calculadora
    if (sess.state.pendingCalcConfirm) {
      if (isYes(userText)) {
        sess.state.pendingCalcConfirm = false;
        sess.state.mode = "calc";
        sess.state.calc = { shape: null, kit: null, inlineTried: false };

        const prompt = calcNextPrompt(sess.state.calc);
        await sleep(humanDelayMs(prompt));
        await sendWhatsAppText({ to: from, bodyText: prompt, trace });
        return res.status(200).json({ ok: true });
      }

      if (isNo(userText)) {
        sess.state.pendingCalcConfirm = false;
        // segue modo mentor normal
      } else {
        const again = "Só pra eu entender: quer usar a calculadora? Responde 1 (sim) ou 2 (não).";
        await sleep(humanDelayMs(again));
        await sendWhatsAppText({ to: from, bodyText: again, trace });
        return res.status(200).json({ ok: true });
      }
    }

    /* =========================
       MODO CALC
       ========================= */
    if (sess.state.mode === "calc" && sess.state.calc) {
      const calc = sess.state.calc;

      // escolher shape
      if (!calc.shape) {
        const n = userText.trim();
        if (n === "1") calc.shape = "retangulo";
        else if (n === "2") calc.shape = "cilindro";
        else if (n === "3") calc.shape = "triangular";
        else if (n === "4") calc.shape = "camada";
        else {
          const again = buildCalcMenu();
          await sleep(humanDelayMs(again));
          await sendWhatsAppText({ to: from, bodyText: again, trace });
          return res.status(200).json({ ok: true });
        }

        const prompt = calcNextPrompt(calc);
        await sleep(humanDelayMs(prompt));
        await sendWhatsAppText({ to: from, bodyText: prompt, trace });
        return res.status(200).json({ ok: true });
      }

      // helper: seta medida com parser e avisa se inválido
      const setLenOrWarn = async (key, parserFn, msg, prompt) => {
        const v = parserFn(userText);
        if (v == null || v <= 0) {
          await sendCalcInvalid({ to: from, trace, msg, prompt });
          return false;
        }
        calc[key] = v;
        return true;
      };

      // Retângulo: tentar inline 30x10x0,5cm antes das perguntas separadas
      if (calc.shape === "retangulo" && !calc.inlineTried) {
        calc.inlineTried = true;

        const inline = parseDims3Inline(userText);
        if (inline) {
          calc.c_cm = inline.c_cm;
          calc.l_cm = inline.l_cm;
          calc.a_cm = inline.a_cm;

          // se mandar o kit junto no mesmo texto, captura também
          const kitInline = parseKitWeights(userText);
          if (kitInline) calc.kit = kitInline;
        } else {
          // se não veio "CxLxA", tenta pegar pelo menos o comprimento
          const c = parseLengthToCm(userText);
          if (c) calc.c_cm = c;
          else {
            await sendCalcInvalid({
              to: from,
              trace,
              msg: "Não consegui entender essas medidas 😅",
              prompt: "Me manda assim: 30x10x0,5cm (ou me diz o comprimento, ex: 30cm):",
            });
            return res.status(200).json({ ok: true });
          }
        }
      } else {
        if (calc.shape === "retangulo") {
          if (calc.c_cm == null) {
            const ok = await setLenOrWarn("c_cm", parseLengthToCm, "Não consegui entender o comprimento 😅", "Comprimento? (ex: 30cm ou 3m)");
            if (!ok) return res.status(200).json({ ok: true });
          } else if (calc.l_cm == null) {
            const ok = await setLenOrWarn("l_cm", parseLengthToCm, "Não consegui entender a largura 😅", "Largura? (ex: 10cm ou 0,8m)");
            if (!ok) return res.status(200).json({ ok: true });
          } else if (calc.a_cm == null) {
            const ok = await setLenOrWarn("a_cm", parseLengthToCm, "Não consegui entender a altura/espessura 😅", "Altura/espessura? (ex: 0,5cm ou 5mm)");
            if (!ok) return res.status(200).json({ ok: true });
          }
        }

        if (calc.shape === "cilindro") {
          if (calc.diam_cm == null) {
            const ok = await setLenOrWarn("diam_cm", parseLengthToCm, "Não consegui entender o diâmetro 😅", "Diâmetro? (ex: 10cm ou 0,3m)");
            if (!ok) return res.status(200).json({ ok: true });
          } else if (calc.a_cm == null) {
            const ok = await setLenOrWarn("a_cm", parseLengthToCm, "Não consegui entender a altura 😅", "Altura/profundidade? (ex: 3cm ou 30mm)");
            if (!ok) return res.status(200).json({ ok: true });
          }
        }

        if (calc.shape === "triangular") {
          if (calc.base_cm == null) {
            const ok = await setLenOrWarn("base_cm", parseLengthToCm, "Não consegui entender a base do triângulo 😅", "Base do triângulo? (ex: 12cm)");
            if (!ok) return res.status(200).json({ ok: true });
          } else if (calc.alttri_cm == null) {
            const ok = await setLenOrWarn("alttri_cm", parseLengthToCm, "Não consegui entender a altura do triângulo 😅", "Altura do triângulo? (ex: 8cm)");
            if (!ok) return res.status(200).json({ ok: true });
          } else if (calc.comp_cm == null) {
            const ok = await setLenOrWarn("comp_cm", parseLengthToCm, "Não consegui entender o comprimento 😅", "Comprimento do prisma? (ex: 40cm ou 1,2m)");
            if (!ok) return res.status(200).json({ ok: true });
          }
        }

        if (calc.shape === "camada") {
          if (calc.c_cm == null) {
            const ok = await setLenOrWarn("c_cm", parseLengthToCm, "Não consegui entender o comprimento 😅", "Comprimento da área? (ex: 1m ou 30cm)");
            if (!ok) return res.status(200).json({ ok: true });
          } else if (calc.l_cm == null) {
            const ok = await setLenOrWarn("l_cm", parseLengthToCm, "Não consegui entender a largura 😅", "Largura da área? (ex: 0,5m ou 20cm)");
            if (!ok) return res.status(200).json({ ok: true });
          } else if (calc.esp_cm == null) {
            const ok = await setLenOrWarn("esp_cm", parseLengthToCm, "Não consegui entender a espessura 😅", "Espessura? (ex: 1mm, 2mm ou 0,2cm)");
            if (!ok) return res.status(200).json({ ok: true });
          }
        }
      }

      const measuresComplete =
        (calc.shape === "retangulo" && calc.c_cm != null && calc.l_cm != null && calc.a_cm != null) ||
        (calc.shape === "cilindro" && calc.diam_cm != null && calc.a_cm != null) ||
        (calc.shape === "triangular" && calc.base_cm != null && calc.alttri_cm != null && calc.comp_cm != null) ||
        (calc.shape === "camada" && calc.c_cm != null && calc.l_cm != null && calc.esp_cm != null);

      // Se medidas completas mas kit ainda não veio, pede kit.
      if (measuresComplete && !calc.kit) {
        const kit = parseKitWeights(userText);
        if (kit) {
          calc.kit = kit;
        } else {
          const prompt = calcNextPrompt(calc);
          await sleep(humanDelayMs(prompt));
          await sendWhatsAppText({ to: from, bodyText: prompt, trace });
          return res.status(200).json({ ok: true });
        }
      }

      if (measuresComplete && calc.kit) {
        const done = finishCalcMessage(calc);
        sess.state.mode = "mentor";
        sess.state.calc = null;

        const parts = splitMessageSmart(done, 4);
        for (const part of parts) {
          await sleep(humanDelayMs(part));
          await sendWhatsAppText({ to: from, bodyText: part, trace });
        }
        return res.status(200).json({ ok: true });
      }

      const prompt = calcNextPrompt(calc);
      await sleep(humanDelayMs(prompt));
      await sendWhatsAppText({ to: from, bodyText: prompt, trace });
      return res.status(200).json({ ok: true });
    }

    /* =========================
       MODO MENTOR (normal)
       ========================= */
    const replyText = await getAIReply({ history: sess.history, userText, trace });

    // salva histórico (se não foi áudio já pré-salvo)
    if (!(msg.type === "audio")) {
      sess.history.push({ role: "user", content: userText });
    }
    sess.history.push({ role: "assistant", content: replyText });
    if (sess.history.length > 18) sess.history.splice(0, sess.history.length - 18);

    const parts = splitMessageSmart(replyText, 6);

    const shouldChunkLong =
      looksLikePlanRequest(userText) ||
      (replyText && replyText.length > 1600);

    if (shouldChunkLong && parts.length > 2) {
      const first = parts.slice(0, 2);
      const rest = parts.slice(2);

      for (const part of first) {
        await sleep(humanDelayMs(part));
        await sendWhatsAppText({ to: from, bodyText: part, trace });
      }

      sess.state.pendingLong = { fullText: replyText, parts: rest };

      const ask = "Quer que eu continue em partes? (sim/continuar)";
      await sleep(humanDelayMs(ask));
      await sendWhatsAppText({ to: from, bodyText: ask, trace });

      return res.status(200).json({ ok: true });
    }

    for (const part of parts) {
      await sleep(humanDelayMs(part));
      await sendWhatsAppText({ to: from, bodyText: part, trace });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.log("❌ Handler error:", err);
    return res.status(200).json({ ok: true });
  }
}
