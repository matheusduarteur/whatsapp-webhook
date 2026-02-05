// /api/webhook.js

const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v20.0";

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;         // ex: whatsapp_webhook_verify_123
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;     // EAAG...
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;   // número grandão da Meta

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;     // sk-...
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// ======= helpers =======

async function sendTextMessage(to, text) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    console.log("❌ Missing WHATSAPP_TOKEN or PHONE_NUMBER_ID");
    return;
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
}

async function getAIReply(userText) {
  // Se não tiver OpenAI key, cai num fallback simples (pra não travar o bot)
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
- Se for urgência (dor insuportável, sangramento forte, febre, inchaço no rosto, pus): orientar procura imediata e oferecer encaminhar para humano.
- Se a pessoa já falar "implante", assuma implante e faça 2-3 perguntas rápidas (ex.: tempo sem dente, dor, região) e puxe para agendamento.
Tom: humano, brasileiro, acolhedor.
`;

  const payload = {
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: system.trim() },
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

// ======= handler =======

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

      // Segurança: se não for evento do WhatsApp, só responde ok
      if (!body?.entry?.length) {
        return res.status(200).json({ ok: true });
      }

      const change = body.entry?.[0]?.changes?.[0];
      const value = change?.value;

      // Ignora status de entrega/leitura
      if (value?.statuses?.length) {
        return res.status(200).json({ ok: true });
      }

      const msg = value?.messages?.[0];
      if (!msg) {
        return res.status(200).json({ ok: true });
      }

      const from = msg.from; // wa_id do usuário
      let userText = "";

      if (msg.type === "text") {
        userText = msg.text?.body || "";
      } else {
        // por enquanto: se mandar áudio/foto etc, responde pedindo texto
        await sendTextMessage(from, "Consigo te ajudar! 🙂 Por enquanto me manda em texto o que você precisa (implante, resina, limpeza, clareamento).");
        return res.status(200).json({ ok: true });
      }

      console.log("📩 Incoming:", { from, userText });

      // Resposta (IA ou fallback)
      const reply = await getAIReply(userText);

      // Envia no WhatsApp
      await sendTextMessage(from, reply);

      return res.status(200).json({ ok: true });
    }

    return res.status(405).send("Method Not Allowed");
  } catch (err) {
    console.log("❌ Handler error:", err);
    return res.status(200).json({ ok: true });
  }
}
