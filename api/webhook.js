const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v20.0";

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function humanDelayMs(text) {
  const base = 700;
  const perChar = 16;
  const jitter = Math.floor(Math.random() * 600);
  const ms = base + (text?.length || 0) * perChar + jitter;
  return Math.min(4500, Math.max(900, ms));
}

async function sendTextMessage(to, text) {
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
  if (!r.ok) console.log("❌ WhatsApp send error:", r.status, data);
  else console.log("✅ WhatsApp sent:", data);
}

async function getAIReply(userText) {
  if (!OPENAI_API_KEY) {
    return "Oi! 😊 Me diga: é implante, estética em resina, limpeza ou clareamento?";
  }

  const system = `
Você é um atendente premium de clínica odontológica no WhatsApp.
Mensagens curtas, uma pergunta por vez, acolhedor.
Não diagnosticar nem prescrever medicamentos.
Se urgência: orientar atendimento imediato.
`.trim();

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userText },
      ],
      temperature: 0.4,
    }),
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.log("❌ OpenAI error:", r.status, data);
    return "Oi! 😊 Me diga: é implante, estética em resina, limpeza ou clareamento?";
  }

  return data?.choices?.[0]?.message?.content?.trim()
    || "Oi! 😊 Me diga: é implante, estética em resina, limpeza ou clareamento?";
}

export default async function handler(req, res) {
  try {
    // GET: verificação
    if (req.method === "GET") {
      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];
      if (mode === "subscribe" && token === VERIFY_TOKEN) {
        return res.status(200).send(challenge);
      }
      return res.status(403).send("Forbidden");
    }

    // POST: mensagens
    if (req.method === "POST") {
      const body = req.body;

      // ✅ ACK IMEDIATO pra Meta (não travar)
      res.status(200).json({ ok: true });

      const value = body?.entry?.[0]?.changes?.[0]?.value;

      // ignora statuses
      if (value?.statuses?.length) return;

      const msg = value?.messages?.[0];
      if (!msg) return;

      const from = msg.from;
      if (!from) return;

      if (msg.type !== "text") {
        const quick = "Consigo te ajudar! 🙂 Por enquanto, me manda em texto: implante, resina, limpeza ou clareamento.";
        await sleep(humanDelayMs(quick));
        await sendTextMessage(from, quick);
        return;
      }

      const userText = msg.text?.body || "";
      console.log("📩 Incoming:", { from, userText });

      const reply = await getAIReply(userText);
      await sleep(humanDelayMs(reply));
      await sendTextMessage(from, reply);
      return;
    }

    return res.status(405).send("Method Not Allowed");
  } catch (err) {
    console.log("❌ Handler error:", err);
    return res.status(200).json({ ok: true });
  }
}
