// api/webhook.js
// WhatsApp Cloud API webhook + resposta com OpenAI + delay humano (Vercel Serverless)

const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v20.0";

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// --------------------
// Delay "humano"
// --------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// delay proporcional ao tamanho + leve aleatoriedade (fica natural)
function humanDelayMs(text) {
  const base = 700;       // ms mínimo
  const perChar = 16;     // ms por caractere (ajuste fino)
  const jitter = Math.floor(Math.random() * 600); // 0–600ms
  const ms = base + (text?.length || 0) * perChar + jitter;
  return Math.min(4500, Math.max(900, ms)); // trava entre 0.9s e 4.5s
}

// --------------------
// WhatsApp send
// --------------------
async function sendTextMessage(to, text) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    console.log("❌ Missing WHATSAPP_TOKEN or PHONE_NUMBER_ID");
    return { ok: false, status: 0, data: { error: "missing_env" } };
  }

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`;

  const body = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  };

  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.log("❌ WhatsApp send error:", r.status, data);
  } else {
    console.log("✅ WhatsApp sent:", data);
  }
  return { ok: r.ok, status: r.status, data };
}

// --------------------
// OpenAI reply
// --------------------
async function getAIReply(userText) {
  // fallback (caso a chave OpenAI não exista)
  if (!OPENAI_API_KEY) {
    return "Oi! 😊 Me diga: é implante, estética em resina, limpeza ou clareamento?";
  }

  const system = `
Você é um atendente premium de clínica odontológica no WhatsApp.
Objetivo: acolher e conduzir o lead para agendar uma avaliação (sem pressionar).

Regras:
- Mensagens curtas.
- Uma pergunta por vez.
- Não diagnosticar nem prescrever medicamento.
- Se urgência (dor insuportável, sangramento forte, febre, inchaço no rosto, pus): orientar procura imediata e oferecer encaminhar para humano.
- Se o lead já falar “implante”, assuma implante: faça 2–3 perguntas rápidas e puxe para agendamento.

Tom: humano, brasileiro, acolhedor.
`.trim();

  const payload = {
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userText },
    ],
    temperature: 0.4,
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.log("❌ OpenAI error:", r.status, data);
    return "Oi! 😊 Me diga: é implante, estética em resina, limpeza ou clareamento?";
  }

  const text = data?.choices?.[0]?.message?.content?.trim();
  return text || "Oi! 😊 Me diga: é implante, estética em resina, limpeza ou clareamento?";
}

// --------------------
// Handler (Vercel)
// --------------------
export default async function handler(req, res) {
  try {
    // --- Verificação do webhook (Meta) ---
    if (req.method === "GET") {
      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];

      if (mode === "subscribe" && token && token === VERIFY_TOKEN) {
        return res.status(200).send(challenge);
      }
      return res.status(403).send("Forbidden");
    }

    // --- Recebendo mensagens (POST) ---
    if (req.method === "POST") {
      const body = req.body;

      // WhatsApp manda também statuses etc — responde OK rápido
      if (!body?.entry?.length) return res.status(200).json({ ok: true });

      const change = body.entry?.[0]?.changes?.[0];
      const value = change?.value;

      // Ignora status de entrega/leitura
      if (value?.statuses?.length) return res.status(200).json({ ok: true });

      const msg = value?.messages?.[0];
      if (!msg) return res.status(200).json({ ok: true });

      const from = msg.from; // wa_id do usuário
      let userText = "";

      if (msg.type === "text") {
        userText = msg.text?.body || "";
      } else {
        // por enquanto: se mandar áudio/foto etc, responde pedindo texto
        // (sem IA, só um recado)
        const quick = "Consigo te ajudar! 🙂 Por enquanto, me manda em texto: implante, resina, limpeza ou clareamento.";
        // delay humano também aqui
        await sleep(humanDelayMs(quick));
        await sendTextMessage(from, quick);
        return res.status(200).json({ ok: true });
      }

      console.log("📩 Incoming:", { from, userText });

      const reply = await getAIReply(userText);

      // ✅ DELAY HUMANO AQUI (principal)
      await sleep(humanDelayMs(reply));

      await sendTextMessage(from, reply);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).send("Method Not Allowed");
  } catch (err) {
    console.log("❌ Handler error:", err);
    // responde OK pra Meta não ficar re-tentando agressivo
    return res.status(200).json({ ok: true });
  }
}
