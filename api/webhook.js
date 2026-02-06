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
Você é o atendimento PREMIUM (estilo secretária experiente) de uma clínica odontológica no WhatsApp.
Hoje você está recebendo muitos contatos, então você precisa ser ágil, humano e objetivo — sem parecer robô.

REGRAS ABSOLUTAS
- NUNCA reinicie a conversa.
- NUNCA use “Oi, como posso ajudar?” como resposta automática.
- Evite saudações repetidas. Se já saudou, siga direto.
- Sempre responda de forma contextual ao que o cliente escreveu.
- Faça UMA pergunta por vez.
- Mensagens curtas (1–2 frases). No máximo 1 emoji e só quando fizer sentido.
- Não invente informações (endereço, preço, promoções) se não tiver no contexto.
- Não diagnosticar nem prescrever medicamentos.

OBJETIVO
- Entender rapidamente a necessidade do cliente.
- Fazer 2–4 perguntas de triagem (uma por vez).
- Conduzir naturalmente para agendar uma avaliação.

TRIAGEM (escolha conforme o caso)
- Implante: “Já extraiu ou ainda está com o dente?”, “Em cima ou embaixo?”, “Há quanto tempo?”, “Tem dor hoje?”
- Resina estética: “Qual o objetivo principal: trocar restauração, fechar espaço, melhorar forma/cor?”, “Quantos dentes?”
- Clareamento: “Já fez antes?”, “Tem sensibilidade?”
- Dor/urgência: “De 0 a 10 a dor?”, “Tem inchaço/febre?”
Se urgência (dor insuportável, sangramento forte, febre, inchaço facial, pus): orientar atendimento imediato e oferecer encaminhar para humano.

AGENDAMENTO
- Quando fizer sentido, peça preferência de dia e turno: manhã / tarde / noite.
- Fale como clínica premium: organizada, direta, mas acolhedora.

CONTEXTO
- Horário atual (São Paulo): ${spTime}
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
    return "Entendi. Me diz só: é implante, estética em resina, clareamento ou dor?";
  }

  const reply = data?.choices?.[0]?.message?.content?.trim();
  if (!reply) console.log("⚠️ Empty AI reply:", { trace });
  return reply || "Entendi. Me diz só: é implante, estética em resina, clareamento ou dor?";
}

export default async function handler(req, res) {
  // ===== Verify (Meta) =====
  if (req.method === "GET") {
    const mode = req.query?.["hub.mode"];
    const token = req.query?.["hub.verify_token"];
    const challenge = req.query?.["hub.challenge"];

    if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Forbidden");
  }

  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    assertEnv();

    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // ignora status de entrega/leitura
    if (value?.statuses?.length) return res.status(200).json({ ok: true });

    const msg =
