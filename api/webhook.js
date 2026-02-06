const sessions = new Map();

// Dedup (Meta pode reenviar evento)
const processed = new Map(); // msgId -> timestamp

function cleanupMap(map, ttlMs) {
  const now = Date.now();
  for (const [k, v] of map.entries()) {
    if (now - v > ttlMs) map.delete(k);
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
  const fmt = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
  });
  return fmt.format(new Date());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function humanDelayMs(text) {
  const len = (text || "").length;
  const base = 900;
  const perChar = 14;
  const jitter = Math.floor(Math.random() * 700);
  const ms = base + len * perChar + jitter;
  return Math.min(5000, Math.max(1200, ms)); // 1.2s a 5s
}

function splitMessage(text) {
  const t = (text || "").trim();
  if (!t) return ["..."];
  if (t.length <= 320) return [t];

  const max1 = 320;
  let cut = t.lastIndexOf("\n", max1);
  if (cut < 120) cut = t.lastIndexOf(". ", max1);
  if (cut < 120) cut = max1;

  const p1 = t.slice(0, cut).trim();
  const p2 = t.slice(cut).trim();

  if (p2.length > 420) return [p1, p2.slice(0, 420).trim() + "…"];
  return [p1, p2];
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

async function getAIReply({ history, userText, trace }) {
  const spTime = nowInSaoPaulo();

  const system = `
Você é o atendimento PREMIUM (estilo secretária experiente) de uma clínic
