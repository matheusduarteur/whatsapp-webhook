// /api/webhook.js
// WhatsApp Cloud API (Vercel) + Severino 🤖 (OpenAI) + Calculadora + Áudio + Imagem + Redis

import { createClient } from "redis";

/* =========================
   Config
   ========================= */
const SEVERINO_NAME = "Severino 🤖";
const PROFESSOR_MATHEUS_WA = "https://wa.me/557781365194";
const HANDOFF_TTL_MS = 2 * 60 * 60 * 1000; // 2h

/* =========================
   Redis (global / lazy)
   ========================= */
let _redis;

async function getRedis() {
  if (_redis && _redis.isOpen) return _redis;

  const url = process.env.REDIS_URL;
  if (!url) throw new Error("Missing env var: REDIS_URL");

  _redis = createClient({ url });
  _redis.on("error", (err) => console.log("❌ Redis error:", err?.message || err));

  await _redis.connect();
  return _redis;
}

/* =========================
   TTLs
   ========================= */
const SESSION_TTL_SECONDS = 6 * 60 * 60; // 6h
const DEDUP_TTL_SECONDS = 10 * 60; // 10min

const keySess = (from) => `sess:${from}`;
const keySeen = (msgId) => `seen:${msgId}`;

/* =========================
   Utils
   ========================= */
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
  const base = 650;
  const perChar = 7;
  const jitter = Math.floor(Math.random() * 600);
  const ms = base + len * perChar + jitter;
  return Math.min(4200, Math.max(520, ms));
}

function splitMessageSmart(text, maxParts = 6) {
  const t = (text || "").trim();
  if (!t) return ["..."];

  const MAX = 650;
  if (t.length <= MAX) return [t];

  const lines = t
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

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

  // ✅ sem prefixo (1/3) etc.
  return finalParts;
}

function assertEnv() {
  const needed = ["VERIFY_TOKEN", "WHATSAPP_TOKEN", "PHONE_NUMBER_ID", "OPENAI_API_KEY", "REDIS_URL"];
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

/* =========================
   Redis helpers
   ========================= */
async function kvGetSession(from) {
  const r = await getRedis();
  const raw = await r.get(keySess(from));
  if (!raw) return null;

  await r.expire(keySess(from), SESSION_TTL_SECONDS);

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function kvSetSession(from, sessObj) {
  const r = await getRedis();
  await r.set(keySess(from), JSON.stringify(sessObj), { EX: SESSION_TTL_SECONDS });
}

async function kvDelSession(from) {
  const r = await getRedis();
  await r.del(keySess(from));
}

async function isDuplicateMsg(msgId) {
  if (!msgId) return false;
  const r = await getRedis();
  const result = await r.set(keySeen(msgId), "1", { NX: true, EX: DEDUP_TTL_SECONDS });
  return result === null;
}

async function ensureSession(from) {
  let sess = await kvGetSession(from);
  if (!sess) {
    sess = {
      history: [],
      profile: { name: null, gender: null, askedName: false },
      state: {
        mode: "mentor", // "mentor" | "calc"
        calc: null,
        pendingLong: null,
        pendingCalcConfirm: false,
        pendingImage: null,
        humanHandoffUntil: 0,
        pendingAfterCalc: false, // ✅ NOVO: menu após cálculo
      },
      _lastTs: Date.now(),
    };
  }

  sess.profile ??= { name: null, gender: null, askedName: false };
  sess.profile.name ??= null;
  sess.profile.gender ??= null;
  sess.profile.askedName ??= false;

  sess.state ??= {
    mode: "mentor",
    calc: null,
    pendingLong: null,
    pendingCalcConfirm: false,
    pendingImage: null,
    humanHandoffUntil: 0,
    pendingAfterCalc: false,
  };
  sess.state.mode ??= "mentor";
  sess.state.calc ??= null;
  sess.state.pendingLong ??= null;
  sess.state.pendingCalcConfirm ??= false;
  sess.state.pendingImage ??= null;
  sess.state.humanHandoffUntil ??= 0;
  sess.state.pendingAfterCalc ??= false;

  // compat do calc
  if (sess.state.calc) {
    sess.state.calc.kit ??= { resinG: null, hardG: null };
    sess.state.calc.pendingUnit ??= null; // { kind:"len"|"weight", key, raw }
  }

  sess._lastTs = Date.now();
  await kvSetSession(from, sess);
  return sess;
}

/* =========================
   Helpers: input inválido calc
   ========================= */
async function sendCalcInvalid({ to, trace, msg, prompt }) {
  const text = `${msg}

📌 Exemplos válidos:
- 30cm
- 0,8m
- 5mm
- 1kg
- 500g

${prompt}`;
  const parts = splitMessageSmart(text, 4);
  for (const p of parts) {
    await sleep(humanDelayMs(p));
    await sendWhatsAppText({ to, bodyText: p, trace });
  }
}

/* =========================
   Severino: nome, gênero, handoff
   ========================= */
function normalizeLoose(s) {
  return (s || "")
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function looksLikeName(text) {
  const t = (text || "").trim();
  if (!t) return false;
  if (t.length > 40) return false;
  const s = normalizeLoose(t);
  if (s.includes("http") || s.includes("@")) return false;
  if (/\d/.test(t)) return false;
  return /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'`´^~\- ]{1,38}$/.test(t);
}

function extractName(text) {
  const raw = (text || "").trim();
  if (!raw) return null;

  const patterns = [
    /me chamo\s+(.+)$/i,
    /meu nome e\s+(.+)$/i,
    /meu nome é\s+(.+)$/i,
    /^sou\s+(.+)$/i,
    /^aqui e\s+(.+)$/i,
    /^aqui é\s+(.+)$/i,
  ];

  let name = null;
  for (const p of patterns) {
    const m = raw.match(p);
    if (m && m[1]) {
      name = m[1].trim();
      break;
    }
  }

  if (!name && looksLikeName(raw)) name = raw;
  if (!name) return null;

  name = name.replace(/[.!?]+$/g, "").trim();
  name = name.replace(/\s{2,}/g, " ");
  if (name.length > 28) name = name.slice(0, 28).trim();

  return looksLikeName(name) ? name : null;
}

function inferGenderFromName(name) {
  const n = normalizeLoose(name).split(" ")[0] || "";
  if (!n) return null;

  const mascExceptions = new Set(["luca", "josue", "jose", "josé", "mica", "micael", "helia", "elias"]);
  if (mascExceptions.has(n)) return "m";

  if (n.endsWith("a")) return "f";
  if (n.endsWith("o") || n.endsWith("os") || n.endsWith("son") || n.endsWith("el") || n.endsWith("us")) return "m";
  return null;
}

function genderHintFromText(text) {
  const s = normalizeLoose(text);
  if (s.includes("sou homem") || s.includes("sou um homem") || s.includes("sou masculino")) return "m";
  if (s.includes("sou mulher") || s.includes("sou uma mulher") || s.includes("sou feminina")) return "f";
  return null;
}

function friendlyAddress(profile) {
  if (profile?.gender === "m") return "meu amigo";
  if (profile?.gender === "f") return "minha amiga";
  return "meu amigo/minha amiga";
}

function shouldUseNameSometimes() {
  return Math.random() < 0.35;
}

function wantsHuman(text) {
  const s = normalizeLoose(text);
  const triggers = [
    "falar com matheus",
    "falar com o matheus",
    "falar com professor",
    "falar com o professor",
    "humano",
    "atendente",
    "suporte humano",
    "quero o matheus",
    "me chama ai",
    "me chama aí",
  ];
  return triggers.some((t) => s.includes(t));
}

function wantsBotBack(text) {
  const s = normalizeLoose(text);
  return s === "#bot" || s.includes("voltar com severino") || s.includes("severino volta") || s.includes("pode voltar severino");
}

function isYes(text) {
  const s = normalizeLoose(text);
  return ["1", "sim", "s", "claro", "bora", "vamos", "quero", "pode", "ok", "beleza"].includes(s);
}

function isNo(text) {
  const s = normalizeLoose(text);
  return ["2", "nao", "não", "n", "agora nao", "agora não", "depois", "não quero"].includes(s);
}

function isCancel(text) {
  const s = normalizeLoose(text);
  return ["cancelar", "cancela", "deixa", "deixa pra la", "deixa pra lá", "nao", "não", "para", "pare"].includes(s);
}

function isEscapeCalc(text) {
  const s = normalizeLoose(text);
  return ["sair", "cancelar", "cancela", "parar", "para", "voltar", "menu", "#mentor", "mentor"].includes(s);
}

/* =========================
   Detector de intenção (calc)
   ========================= */
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
    "quanto endurecedor",
    "mistura",
    "proporcao",
    "proporção",
    "litros",
    "ml",
    "kg",
    "grama",
    "gramas",
  ];

  return keywords.some((k) => s.includes(normalizeLoose(k)));
}

/* =========================
   CALCULADORA (core)
   ========================= */
const DENSITY_KG_PER_L = 1.10;
const PI = Math.PI;

function isBareNumber(input) {
  const t = (input || "").toString().trim().toLowerCase().replace(",", ".");
  return /^(\d+(\.\d+)?)$/.test(t);
}

function parseUnitOnly(input) {
  const s = normalizeLoose(input);

  // length
  if (s === "mm" || s === "milimetro" || s === "milimetros") return "mm";
  if (s === "cm" || s === "centimetro" || s === "centimetros") return "cm";
  if (s === "m" || s === "metro" || s === "metros") return "m";

  // weight
  if (s === "g" || s === "grama" || s === "gramas") return "g";
  if (s === "kg" || s === "quilo" || s === "quilos" || s === "kilograma" || s === "kilogramas") return "kg";

  return null;
}

function applyUnitToBareNumber(numStr, unit) {
  const val = Number((numStr || "").toString().replace(",", "."));
  if (!Number.isFinite(val) || val <= 0) return null;

  // length -> cm
  if (unit === "m") return val * 100;
  if (unit === "mm") return val / 10;
  if (unit === "cm") return val;

  // weight -> g
  if (unit === "kg") return val * 1000;
  if (unit === "g") return val;

  return null;
}

function parseLengthToCm(input) {
  const t = (input || "").toString().trim().toLowerCase().replace(",", ".");
  const m = t.match(/^(\d+(\.\d+)?)(mm|cm|m)$/);
  if (!m) return null;

  const val = Number(m[1]);
  if (!Number.isFinite(val) || val <= 0) return null;

  const unit = m[3];
  if (unit === "m") return val * 100;
  if (unit === "mm") return val / 10;
  return val;
}

function parseWeightToG(input) {
  const t = (input || "").toString().trim().toLowerCase().replace(",", ".");
  const m = t.match(/^(\d+(\.\d+)?)(kg|g)$/);
  if (!m) return null;

  const val = Number(m[1]);
  if (!Number.isFinite(val) || val <= 0) return null;

  const unit = m[3];
  return unit === "kg" ? val * 1000 : val;
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

  if (shape === "retangulo" || shape === "canaleta") {
    const cm3 = calc.c_cm * calc.l_cm * calc.a_cm;
    return litersFromCm3(cm3);
  }
  if (shape === "cilindro") {
    const r = calc.diam_cm / 2;
    const cm3 = PI * r * r * calc.a_cm;
    return litersFromCm3(cm3);
  }
  if (shape === "camada") {
    const cm3 = calc.c_cm * calc.l_cm * calc.esp_cm;
    return litersFromCm3(cm3);
  }
  return null;
}

function buildCalcMenu() {
  return `🧮 Calculadora exclusiva de Alunos:

Escolha o formato:

1) Retângulo (exemplo: rio de resina)
2) Cilindro (ex: mesa redonda)
3) Canaleta Tábua
4) Camada superficial

📌 Responda só com o número (1 a 4)`;
}

function calcNextPrompt(calc) {
  if (!calc.shape) return buildCalcMenu();

  if (calc.shape === "retangulo") {
    if (calc.c_cm == null) return "Qual o comprimento? (mande o valor e a medida, ex: 30cm)";
    if (calc.l_cm == null) return "Qual a largura? (mande o valor e a medida, ex: 10cm)";
    if (calc.a_cm == null) return "Qual a espessura/altura? (mande o valor e a medida, ex: 0,5cm)";
  }

  if (calc.shape === "cilindro") {
    if (calc.diam_cm == null) return "Qual o diâmetro? (mande o valor e a medida, ex: 80cm)";
    if (calc.a_cm == null) return "Qual a altura/profundidade? (mande o valor e a medida, ex: 4cm)";
  }

  if (calc.shape === "canaleta") {
    if (calc.c_cm == null) return "Qual o comprimento da canaleta? (mande o valor e a medida, ex: 60cm)";
    if (calc.l_cm == null) return "Qual a largura da canaleta? (mande o valor e a medida, ex: 2cm)";
    if (calc.a_cm == null) return "Qual a profundidade da canaleta? (mande o valor e a medida, ex: 1cm)";
  }

  if (calc.shape === "camada") {
    if (calc.c_cm == null) return "Qual o comprimento da área? (mande o valor e a medida, ex: 1m)";
    if (calc.l_cm == null) return "Qual a largura da área? (mande o valor e a medida, ex: 40cm)";
    if (calc.esp_cm == null) return "Qual a espessura da camada? (mande o valor e a medida, ex: 2mm)";
  }

  calc.kit ??= { resinG: null, hardG: null };
  if (calc.kit.resinG == null) return "Quanto veio de *Resina (Componente A)*? (ex: 1kg ou 500g)";
  if (calc.kit.hardG == null) return "E quanto veio de *Endurecedor (Componente B)*? (ex: 120g ou 0,12kg)";

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

  return `✅ Cálculo pronto

⚖️ *Total aproximado*: ${formatKg(kgTotal)} (${formatG(gTotal)})

🧪 Mistura (baseado no seu KIT):
- *Resina*: ${formatG(resin_g)}
- *Endurecedor*: ${formatG(hard_g)}`;
}

/* =========================
   Plano em partes
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
   WhatsApp Media: meta + download
   ========================= */
async function getWhatsAppMediaMeta(mediaId, trace) {
  const url = `https://graph.facebook.com/v22.0/${mediaId}`;
  const r = await fetchWithTimeout(
    url,
    { method: "GET", headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } },
    12000
  );

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.log("❌ Media meta error:", { trace, status: r.status, data: JSON.stringify(data).slice(0, 900) });
    return null;
  }
  return data;
}

async function downloadWhatsAppMediaFile(mediaUrl, trace) {
  const r = await fetchWithTimeout(
    mediaUrl,
    { method: "GET", headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } },
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

/* =========================
   ÁUDIO -> transcrição (OpenAI)
   ========================= */
async function transcribeWithOpenAI({ arrayBuffer, contentType, trace }) {
  const model = process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1";

  const form = new FormData();
  const blob = new Blob([arrayBuffer], { type: contentType });
  const filename = contentType.includes("ogg") ? "audio.ogg" : "audio.bin";

  form.append("model", model);
  form.append("file", blob, filename);

  const r = await fetchWithTimeout(
    "https://api.openai.com/v1/audio/transcriptions",
    { method: "POST", headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: form },
    25000
  );

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.log("❌ OpenAI transcription error:", { trace, status: r.status, data: JSON.stringify(data).slice(0, 900) });
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

  return await transcribeWithOpenAI({
    arrayBuffer: file.arrayBuffer,
    contentType: meta.mime_type || file.contentType,
    trace,
  });
}

/* =========================
   IMAGEM -> análise (OpenAI Vision)
   ========================= */
function arrayBufferToBase64(ab) {
  return Buffer.from(ab).toString("base64");
}

async function analyzeImageWithOpenAI({ imageArrayBuffer, mimeType, userRequest, caption, history, trace, profile }) {
  const model = process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini";
  const spTime = nowInSaoPaulo();

  const addr = friendlyAddress(profile);
  const studentName = profile?.name || null;

  const system = `
Você é o ${SEVERINO_NAME}, o assistente "faz-tudo" da Universidade da Resina (Prof. Matheus).
Regras:
- NÃO invente detalhes que não dá pra ver.
- Foque em: bolhas, cura/pegajosidade, marcas de lixamento, contaminação/poeira, selagem, nivelamento, vazamento/moldes.
- Entregue: (1) diagnóstico provável, (2) causa provável, (3) o que fazer agora, (4) prevenção.
- Tom WhatsApp: direto, sem enrolar (0–2 emojis).
- Termine com 1 pergunta objetiva.
Aluno: ${studentName || "desconhecido"} | Tratamento: ${addr}
Horário (SP): ${spTime}
`.trim();

  const b64 = arrayBufferToBase64(imageArrayBuffer);
  const dataUrl = `data:${mimeType};base64,${b64}`;

  const contextText = [
    caption ? `Legenda da foto (caption): ${caption}` : null,
    userRequest ? `Pedido do aluno: ${userRequest}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const payload = {
    model,
    messages: [
      { role: "system", content: system },
      ...(history || []),
      {
        role: "user",
        content: [
          { type: "text", text: contextText || "Analise a foto da peça e me oriente." },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    temperature: 0.45,
  };

  const r = await fetchWithTimeout(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    25000
  );

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.log("❌ OpenAI vision error:", { trace, status: r.status, data: JSON.stringify(data).slice(0, 900) });
    return "Deu um erro na hora de analisar a imagem 😅 Pode mandar a foto de novo (mais perto/mais luz) e me dizer o que você quer que eu avalie nela?";
  }

  return data?.choices?.[0]?.message?.content?.trim() ||
    "Recebi a imagem. Me diz em 1 frase o que você quer que eu avalie nela (bolhas, cura, acabamento, molde, etc.).";
}
/* =========================
   AGENTE SEVERINO 🤖 (texto)
   ========================= */
async function getAIReply({ history, userText, trace, profile }) {
  const spTime = nowInSaoPaulo();
  const name = profile?.name || null;
  const gender = profile?.gender || null;
  const addr = friendlyAddress(profile);
  const useName = name && shouldUseNameSometimes() ? ` (${name})` : "";

  const system = `
Você é o ${SEVERINO_NAME}, o assistente "faz-tudo" da Universidade da Resina (Prof. Matheus).

TOM
- WhatsApp: curto por padrão; aprofunda se pedirem.
- Use "${addr}" às vezes (não toda hora).
- Emojis com intenção (0–2).
- Ao falar de si, use "Severino 🤖".

ALUNO
- Nome: ${name || "desconhecido"}
- Gênero: ${gender || "desconhecido"}
- Você pode usar o nome no máximo 1 vez nessa resposta${useName}.

REGRA SOBRE CÁLCULOS
- Se o usuário pedir cálculo, NÃO faça conta manual no texto.
- Ofereça a calculadora e peça confirmação (1 sim / 2 não).

PLANOS LONGOS
Quando pedir plano/guia/checklist:
1) resumo curto
2) "Quer que eu continue em partes? (sim/continuar)"

REGRAS
- Não invente marca/linha.
- Termine com UMA pergunta prática.

Horário (SP): ${spTime}
`.trim();

  const payload = {
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages: [{ role: "system", content: system }, ...(history || []), { role: "user", content: userText }],
    temperature: 0.55,
  };

  const r = await fetchWithTimeout(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    15000
  );

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.log("❌ OpenAI error:", { trace, status: r.status, data: JSON.stringify(data).slice(0, 900) });
    return `Entendi, ${addr}. Quer usar a *Calculadora de Resina* agora?\n\n1) Sim, quero calcular\n2) Não, só uma orientação`;
  }

  return (
    data?.choices?.[0]?.message?.content?.trim() ||
    `Entendi, ${addr}. Quer usar a *Calculadora de Resina* agora?\n\n1) Sim, quero calcular\n2) Não, só uma orientação`
  );
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

    // Dedup
    if (await isDuplicateMsg(msgId)) return res.status(200).json({ ok: true });

    if (msg.type === "sticker") return res.status(200).json({ ok: true });

    const sess = await ensureSession(from);

    /* =========================
       Handoff gating
       ========================= */
    const now = Date.now();

    if (sess.state.humanHandoffUntil && sess.state.humanHandoffUntil > now) {
      if (msg.type === "text") {
        const t = msg.text?.body?.trim() || "";
        const s = normalizeLoose(t);
        const allow = wantsBotBack(t) || s === "#reset" || s === "#calc" || isCalcIntent(t);

        if (allow) {
          sess.state.humanHandoffUntil = 0;
          await kvSetSession(from, sess);
        } else {
          return res.status(200).json({ ok: true });
        }
      } else {
        return res.status(200).json({ ok: true });
      }
    }

    /* =========================
       1) IMAGEM
       ========================= */
    if (msg.type === "image") {
      const mediaId = msg.image?.id;
      const caption = msg.image?.caption || "";

      if (!mediaId) {
        const quick = "Recebi uma imagem, mas não consegui puxar o arquivo 😅 Pode mandar de novo?";
        await sleep(humanDelayMs(quick));
        await sendWhatsAppText({ to: from, bodyText: quick, trace });
        return res.status(200).json({ ok: true });
      }

      sess.state.pendingImage = { mediaId, caption: caption || "", ts: Date.now() };
      await kvSetSession(from, sess);

      const ask = `📸 Foto recebida!
Me diz em uma frase o que você quer que eu avalie nela.

Exemplos:
- “tá dando bolhas, por quê?”
- “ficou pegajoso”
- “marcas no lixamento”
- “deu vazamento no molde”
- “como melhorar o acabamento?”`;

      await sleep(humanDelayMs(ask));
      await sendWhatsAppText({ to: from, bodyText: ask, trace });
      return res.status(200).json({ ok: true });
    }

    /* =========================
       2) TEXTO (ou ÁUDIO)
       ========================= */
    let userText = "";

    if (msg.type === "text") {
      userText = msg.text?.body?.trim() || "";
      if (!userText) return res.status(200).json({ ok: true });
    } else if (msg.type === "audio") {
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
      sess.history.push({ role: "user", content: `🗣️ (áudio) ${userText.slice(0, 900)}` });
      if (sess.history.length > 18) sess.history.splice(0, sess.history.length - 18);
    } else {
      const quick = "Consigo te ajudar 🙂 Me manda em texto sua dúvida (ou manda um áudio / foto).";
      await sleep(humanDelayMs(quick));
      await sendWhatsAppText({ to: from, bodyText: quick, trace });
      return res.status(200).json({ ok: true });
    }

    /* =========================
       Handoff humano (pedido)
       ========================= */
    if (wantsHuman(userText)) {
      const addr = friendlyAddress(sess.profile);
      const msgHandoff = `Claro, ${addr} 🙂  
Se quiser falar direto com o professor Matheus, é só tocar aqui:
👉 ${PROFESSOR_MATHEUS_WA}

Quando quiser voltar pro ${SEVERINO_NAME} depois, é só mandar: #bot`;

      sess.state.humanHandoffUntil = Date.now() + HANDOFF_TTL_MS;

      await sleep(humanDelayMs(msgHandoff));
      await sendWhatsAppText({ to: from, bodyText: msgHandoff, trace });

      await kvSetSession(from, sess);
      return res.status(200).json({ ok: true });
    }

    if (wantsBotBack(userText)) {
      sess.state.humanHandoffUntil = 0;
      const back = `Fechado 🙂 Aqui é o ${SEVERINO_NAME}. Me diz o que você precisa agora.`;
      await sleep(humanDelayMs(back));
      await sendWhatsAppText({ to: from, bodyText: back, trace });
      await kvSetSession(from, sess);
      return res.status(200).json({ ok: true });
    }

    const gHint = genderHintFromText(userText);
    if (gHint) sess.profile.gender = gHint;

    // capturar nome
    if (!sess.profile.name) {
      const maybe = extractName(userText);
      if (maybe) {
        sess.profile.name = maybe;
        if (!sess.profile.gender) sess.profile.gender = inferGenderFromName(maybe);

        const addr = friendlyAddress(sess.profile);
        const hi = `Perfeito, ${sess.profile.name}! 🙂  
Eu sou o ${SEVERINO_NAME}, assistente da Universidade da Resina.  
Me diz, ${addr}: você quer tirar uma dúvida, mandar foto/áudio, ou quer calcular resina?`;

        await sleep(humanDelayMs(hi));
        await sendWhatsAppText({ to: from, bodyText: hi, trace });

        await kvSetSession(from, sess);
        return res.status(200).json({ ok: true });
      }

      if (!sess.profile.askedName) {
        sess.profile.askedName = true;
        const intro = `Olá! Eu sou o ${SEVERINO_NAME}, assistente da Universidade da Resina.  
Tô aqui pra te ajudar no que precisar — dúvidas, cálculos, áudios e fotos.

Como posso te chamar? 🙂`;

        await sleep(humanDelayMs(intro));
        await sendWhatsAppText({ to: from, bodyText: intro, trace });

        await kvSetSession(from, sess);
        return res.status(200).json({ ok: true });
      }
    }

    /* =========================
       #reset
       ========================= */
    if (normalizeLoose(userText) === "#reset") {
      await kvDelSession(from);
      const ok = "Sessão resetada ✅ Pode mandar sua dúvida do zero.";
      await sleep(humanDelayMs(ok));
      await sendWhatsAppText({ to: from, bodyText: ok, trace });
      return res.status(200).json({ ok: true });
    }

    /* =========================
       ✅ Pós-cálculo (menu 1/2)
       ========================= */
    if (sess.state.pendingAfterCalc) {
      const s = normalizeLoose(userText);

      const wantsAgain = ["1", "sim", "s", "quero", "bora", "vamos", "ok", "beleza"].includes(s);
      const wantsMentor = ["2", "nao", "não", "n", "depois"].includes(s);

      if (wantsAgain) {
        sess.state.pendingAfterCalc = false;
        sess.state.mode = "calc";
        sess.state.calc = { shape: null, kit: { resinG: null, hardG: null }, pendingUnit: null };

        const prompt = calcNextPrompt(sess.state.calc);
        await sleep(humanDelayMs(prompt));
        await sendWhatsAppText({ to: from, bodyText: prompt, trace });

        await kvSetSession(from, sess);
        return res.status(200).json({ ok: true });
      }

      if (wantsMentor) {
        sess.state.pendingAfterCalc = false;
        const ok = "Fechado 🙂 Voltamos pro mentor. Me manda sua dúvida.";
        await sleep(humanDelayMs(ok));
        await sendWhatsAppText({ to: from, bodyText: ok, trace });

        await kvSetSession(from, sess);
        return res.status(200).json({ ok: true });
      }

      const again = "Só pra eu entender: quer calcular outra peça? Responde 1 (sim) ou 2 (não).";
      await sleep(humanDelayMs(again));
      await sendWhatsAppText({ to: from, bodyText: again, trace });

      await kvSetSession(from, sess);
      return res.status(200).json({ ok: true });
    }

    /* =========================
       Escape calc (sair/menu)
       ========================= */
    if (sess.state.mode === "calc" || sess.state.pendingCalcConfirm) {
      if (isEscapeCalc(userText)) {
        sess.state.mode = "mentor";
        sess.state.calc = null;
        sess.state.pendingCalcConfirm = false;

        const ok =
          "Fechado 🙂 Saímos da calculadora e voltamos pro mentor. Me diz qual é a tua dúvida agora (ou, se quiser calcular depois, é só mandar “quero calcular”).";
        await sleep(humanDelayMs(ok));
        await sendWhatsAppText({ to: from, bodyText: ok, trace });

        await kvSetSession(from, sess);
        return res.status(200).json({ ok: true });
      }
    }

    /* =========================
       IMAGEM pendente -> analisar
       ========================= */
    if (sess.state.pendingImage?.mediaId) {
      if (isCancel(userText)) {
        sess.state.pendingImage = null;
        await kvSetSession(from, sess);

        const ok = "Fechado 🙂 Se quiser, manda outra foto depois e me diz o que você quer avaliar.";
        await sleep(humanDelayMs(ok));
        await sendWhatsAppText({ to: from, bodyText: ok, trace });
        return res.status(200).json({ ok: true });
      }

      const { mediaId, caption } = sess.state.pendingImage;

      const ack = "Boa — tô analisando a foto agora 📸";
      await sleep(humanDelayMs(ack));
      await sendWhatsAppText({ to: from, bodyText: ack, trace });

      const meta = await getWhatsAppMediaMeta(mediaId, trace);
      if (!meta?.url) {
        sess.state.pendingImage = null;
        await kvSetSession(from, sess);

        const fail = "Não consegui baixar essa foto 😅 Pode reenviar (boa luz) e me dizer o que avaliar?";
        await sleep(humanDelayMs(fail));
        await sendWhatsAppText({ to: from, bodyText: fail, trace });
        return res.status(200).json({ ok: true });
      }

      if (meta.file_size && Number(meta.file_size) > 6_000_000) {
        sess.state.pendingImage = null;
        await kvSetSession(from, sess);

        const big =
          "Essa foto veio bem pesada 😅 Se puder, manda de novo em resolução menor (como ‘foto’ normal, não ‘documento’) que eu analiso certinho.";
        await sleep(humanDelayMs(big));
        await sendWhatsAppText({ to: from, bodyText: big, trace });
        return res.status(200).json({ ok: true });
      }

      const file = await downloadWhatsAppMediaFile(meta.url, trace);
      if (!file?.arrayBuffer) {
        sess.state.pendingImage = null;
        await kvSetSession(from, sess);

        const fail = "Não consegui baixar essa foto 😅 Pode reenviar com mais luz e mais perto da peça?";
        await sleep(humanDelayMs(fail));
        await sendWhatsAppText({ to: from, bodyText: fail, trace });
        return res.status(200).json({ ok: true });
      }

      const analysis = await analyzeImageWithOpenAI({
        imageArrayBuffer: file.arrayBuffer,
        mimeType: meta.mime_type || file.contentType || "image/jpeg",
        userRequest: userText,
        caption,
        history: sess.history,
        trace,
        profile: sess.profile,
      });

      sess.state.pendingImage = null;

      sess.history.push({ role: "user", content: `🖼️ (imagem) ${userText.slice(0, 300)}` });
      sess.history.push({ role: "assistant", content: analysis.slice(0, 900) });
      if (sess.history.length > 18) sess.history.splice(0, sess.history.length - 18);

      await kvSetSession(from, sess);

      const parts = splitMessageSmart(analysis, 6);
      for (const part of parts) {
        await sleep(humanDelayMs(part));
        await sendWhatsAppText({ to: from, bodyText: part, trace });
      }
      return res.status(200).json({ ok: true });
    }

    /* =========================
       debug calc (#calc)
       ========================= */
    if (normalizeLoose(userText) === "#calc") {
      sess.state.mode = "calc";
      sess.state.calc = { shape: null, kit: { resinG: null, hardG: null }, pendingUnit: null };
      sess.state.pendingCalcConfirm = false;

      const prompt = calcNextPrompt(sess.state.calc);
      await sleep(humanDelayMs(prompt));
      await sendWhatsAppText({ to: from, bodyText: prompt, trace });

      await kvSetSession(from, sess);
      return res.status(200).json({ ok: true });
    }

    /* =========================
       pendência de plano em partes
       ========================= */
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

      await kvSetSession(from, sess);
      return res.status(200).json({ ok: true });
    }

    /* =========================
       Oferta da calculadora
       ========================= */
    if (sess.state.mode !== "calc" && isCalcIntent(userText) && !sess.state.pendingCalcConfirm) {
      sess.state.pendingCalcConfirm = true;

      const offer = `🧮 Quer usar a *Calculadora de Resina* agora?

1) Sim, quero calcular
2) Não, só uma orientação
(Se quiser sair: manda "sair")`;

      await sleep(humanDelayMs(offer));
      await sendWhatsAppText({ to: from, bodyText: offer, trace });

      await kvSetSession(from, sess);
      return res.status(200).json({ ok: true });
    }

    if (sess.state.pendingCalcConfirm) {
      if (isYes(userText)) {
        sess.state.pendingCalcConfirm = false;
        sess.state.mode = "calc";
        sess.state.calc = { shape: null, kit: { resinG: null, hardG: null }, pendingUnit: null };

        const prompt = calcNextPrompt(sess.state.calc);
        await sleep(humanDelayMs(prompt));
        await sendWhatsAppText({ to: from, bodyText: prompt, trace });

        await kvSetSession(from, sess);
        return res.status(200).json({ ok: true });
      }

      if (isNo(userText)) {
        sess.state.pendingCalcConfirm = false;
        // segue mentor
      } else {
        const again = 'Só pra eu entender: quer usar a calculadora? Responde 1 (sim) ou 2 (não). (ou manda "sair")';
        await sleep(humanDelayMs(again));
        await sendWhatsAppText({ to: from, bodyText: again, trace });

        await kvSetSession(from, sess);
        return res.status(200).json({ ok: true });
      }
    }

    /* =========================
       MODO CALC (100% estável)
       ========================= */
    /* =========================
   MODO CALC (100% estável) ✅ FIX FINAL
   ========================= */
if (sess.state.mode === "calc" && sess.state.calc) {
  const calc = sess.state.calc;
  calc.kit ??= { resinG: null, hardG: null };
  calc.pendingUnit ??= null;

  // ✅ helper: pergunta unidade e ENCERRA request
  const askUnit = async (kind, key, raw) => {
    calc.pendingUnit = { kind, key, raw };
    const ask = kind === "len" ? "Qual unidade você quis dizer? (mm, cm ou m)" : "Qual unidade? (g ou kg)";
    await sleep(humanDelayMs(ask));
    await sendWhatsAppText({ to: from, bodyText: ask, trace });
    await kvSetSession(from, sess);
    return res.status(200).json({ ok: true });
  };

  // ✅ FIX GLOBAL: se chegou unidade, aplica e ENCERRA (não pula etapa)
  if (calc.pendingUnit) {
    const prev = calc.pendingUnit;
    const u = parseUnitOnly(userText);

    const isLen = prev.kind === "len";
    const isWeight = prev.kind === "weight";

    const okUnit =
      (isLen && (u === "mm" || u === "cm" || u === "m")) ||
      (isWeight && (u === "g" || u === "kg"));

    if (!okUnit) {
      const again = isLen ? "Qual unidade você quis dizer? (mm, cm ou m)" : "Qual unidade? (g ou kg)";
      await sleep(humanDelayMs(again));
      await sendWhatsAppText({ to: from, bodyText: again, trace });
      await kvSetSession(from, sess);
      return res.status(200).json({ ok: true });
    }

    const applied = applyUnitToBareNumber(prev.raw, u);
    if (applied != null) {
      if (isLen) calc[prev.key] = applied; // cm
      else {
        if (prev.key === "resinG") calc.kit.resinG = applied; // g
        if (prev.key === "hardG") calc.kit.hardG = applied; // g
      }
    }

    calc.pendingUnit = null;

    const next = calcNextPrompt(calc);
    await sleep(humanDelayMs(next));
    await sendWhatsAppText({ to: from, bodyText: next, trace });

    await kvSetSession(from, sess);
    return res.status(200).json({ ok: true });
  }

  // shape selection
  if (!calc.shape) {
    const n = userText.trim();
    if (n === "1") calc.shape = "retangulo";
    else if (n === "2") calc.shape = "cilindro";
    else if (n === "3") calc.shape = "canaleta";
    else if (n === "4") calc.shape = "camada";
    else {
      const again = buildCalcMenu();
      await sleep(humanDelayMs(again));
      await sendWhatsAppText({ to: from, bodyText: again, trace });
      await kvSetSession(from, sess);
      return res.status(200).json({ ok: true });
    }

    const prompt = calcNextPrompt(calc);
    await sleep(humanDelayMs(prompt));
    await sendWhatsAppText({ to: from, bodyText: prompt, trace });
    await kvSetSession(from, sess);
    return res.status(200).json({ ok: true });
  }

  // ✅ helper: quando salva algo (medida/peso), SEMPRE pergunta o próximo e retorna
  const commitAndAskNext = async () => {
    const next = calcNextPrompt(calc);
    await sleep(humanDelayMs(next));
    await sendWhatsAppText({ to: from, bodyText: next, trace });
    await kvSetSession(from, sess);
    return res.status(200).json({ ok: true });
  };

  // helper: set length (supports bare number -> ask unit)
  const setLenStep = async (key, labelMsg) => {
    if (isBareNumber(userText)) {
      return await askUnit("len", key, userText.trim().replace(",", "."));
    }
    const v = parseLengthToCm(userText);
    if (v == null) {
      await sendCalcInvalid({
        to: from,
        trace,
        msg: `Não consegui entender ${labelMsg} 😅`,
        prompt: "Manda com unidade: ex 30cm, 1m, 5mm",
      });
      await kvSetSession(from, sess);
      return res.status(200).json({ ok: true });
    }
    calc[key] = v;
    return await commitAndAskNext(); // ✅ RETORNA AQUI (não continua)
  };

  // helper: set weight A/B (supports bare number -> ask unit)
  const setWeightStep = async (key, prettyName) => {
    if (isBareNumber(userText)) {
      return await askUnit("weight", key, userText.trim().replace(",", "."));
    }
    const g = parseWeightToG(userText);
    if (g == null) {
      await sendCalcInvalid({
        to: from,
        trace,
        msg: `Não consegui entender o ${prettyName} 😅`,
        prompt: "Manda com unidade: ex 1kg ou 500g",
      });
      await kvSetSession(from, sess);
      return res.status(200).json({ ok: true });
    }
    if (key === "resinG") calc.kit.resinG = g;
    if (key === "hardG") calc.kit.hardG = g;
    return await commitAndAskNext(); // ✅ RETORNA AQUI
  };

  // ✅ fluxo de medidas por shape (um passo por mensagem)
  if (calc.shape === "retangulo") {
    if (calc.c_cm == null) return await setLenStep("c_cm", "o comprimento");
    if (calc.l_cm == null) return await setLenStep("l_cm", "a largura");
    if (calc.a_cm == null) return await setLenStep("a_cm", "a espessura/altura");
  }

  if (calc.shape === "cilindro") {
    if (calc.diam_cm == null) return await setLenStep("diam_cm", "o diâmetro");
    if (calc.a_cm == null) return await setLenStep("a_cm", "a altura/profundidade");
  }

  if (calc.shape === "canaleta") {
    if (calc.c_cm == null) return await setLenStep("c_cm", "o comprimento");
    if (calc.l_cm == null) return await setLenStep("l_cm", "a largura");
    if (calc.a_cm == null) return await setLenStep("a_cm", "a profundidade");
  }

  if (calc.shape === "camada") {
    if (calc.c_cm == null) return await setLenStep("c_cm", "o comprimento");
    if (calc.l_cm == null) return await setLenStep("l_cm", "a largura");
    if (calc.esp_cm == null) return await setLenStep("esp_cm", "a espessura");
  }

  // ✅ se medidas completas, começa kit A/B
  const measuresComplete =
    (calc.shape === "retangulo" && calc.c_cm != null && calc.l_cm != null && calc.a_cm != null) ||
    (calc.shape === "cilindro" && calc.diam_cm != null && calc.a_cm != null) ||
    (calc.shape === "canaleta" && calc.c_cm != null && calc.l_cm != null && calc.a_cm != null) ||
    (calc.shape === "camada" && calc.c_cm != null && calc.l_cm != null && calc.esp_cm != null);

  if (measuresComplete && calc.kit.resinG == null) return await setWeightStep("resinG", "Componente A (Resina)");
  if (measuresComplete && calc.kit.resinG != null && calc.kit.hardG == null) return await setWeightStep("hardG", "Componente B (Endurecedor)");

  // ✅ finalizar
  if (measuresComplete && calc.kit.resinG != null && calc.kit.hardG != null) {
    const done = finishCalcMessage(calc);

    sess.state.mode = "mentor";
    sess.state.calc = null;

    const parts = splitMessageSmart(done, 4);
    for (const part of parts) {
      await sleep(humanDelayMs(part));
      await sendWhatsAppText({ to: from, bodyText: part, trace });
    }

    sess.state.pendingAfterCalc = true;
    const ask = `Quer calcular outra peça?

1) Sim (calcular outra)
2) Não (voltar pro mentor)`;

    await sleep(humanDelayMs(ask));
    await sendWhatsAppText({ to: from, bodyText: ask, trace });

    await kvSetSession(from, sess);
    return res.status(200).json({ ok: true });
  }

  // fallback (não deveria cair aqui, mas garante)
  const prompt = calcNextPrompt(calc);
  await sleep(humanDelayMs(prompt));
  await sendWhatsAppText({ to: from, bodyText: prompt, trace });
  await kvSetSession(from, sess);
  return res.status(200).json({ ok: true });
}

    /* =========================
       MODO MENTOR
       ========================= */
    const replyText = await getAIReply({ history: sess.history, userText, trace, profile: sess.profile });

    sess.history.push({ role: "user", content: userText.slice(0, 700) });
    sess.history.push({ role: "assistant", content: replyText.slice(0, 900) });
    if (sess.history.length > 18) sess.history.splice(0, sess.history.length - 18);

    const parts = splitMessageSmart(replyText, 6);
    const shouldChunkLong = looksLikePlanRequest(userText) || (replyText && replyText.length > 1600);

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

      await kvSetSession(from, sess);
      return res.status(200).json({ ok: true });
    }

    for (const part of parts) {
      await sleep(humanDelayMs(part));
      await sendWhatsAppText({ to: from, bodyText: part, trace });
    }

    await kvSetSession(from, sess);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.log("❌ Handler error:", err);
    return res.status(200).json({ ok: true });
  }
}
