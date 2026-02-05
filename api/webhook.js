// api/webhook.js

import { DENTAL_LEADS_SYSTEM_PROMPT } from "./agent_prompts.js";

const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v20.0";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// ---- WhatsApp: enviar texto ----
async function sendTextMessage(to, text) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`;

  const body = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text }
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const data = await resp.json();
  if (!resp.ok) console.error("Erro ao enviar WhatsApp:", resp.status, data);
  return data;
}

// ---- OpenAI: extrair texto do output (sem SDK) ----
function extractOutputText(openaiResponseJson) {
  // A Responses API retorna uma estrutura com "output" (itens).
  // Vamos coletar todo texto encontrado em mensagens de saída.
  const out = openaiResponseJson?.output;
  if (!Array.isArray(out)) return "";

  let text = "";
  for (const item of out) {
    // Alguns itens são mensagens com "content"
    if (item?.type === "message" && Array.isArray(item?.content)) {
      for (const c of item.content) {
        if (c?.type === "output_text" && typeof c?.text === "string") {
          text += c.text;
        }
      }
    }
  }
  return text.trim();
}

// ---- OpenAI: gerar resposta ----
async function generateAIReply(userText) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY não configurada no Vercel.");
  }

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      instructions: DENTAL_LEADS_SYSTEM_PROMPT,
      // input pode ser string simples; vamos mandar a mensagem do usuário
      input: userText,
      // mantém barato e rápido nos testes
      max_output_tokens: 250
    })
  });

  const data = await resp.json();
  if (!resp.ok) {
    console.error("Erro OpenAI:", resp.status, data);
    throw new Error("Falha ao chamar OpenAI.");
  }

  const text = extractOutputText(data);
  return text || "Perfeito! Só me diga seu nome pra eu te ajudar a agendar 🙂";
}

export default async function handler(req, res) {
  // ---- Verificação do webhook (Meta) ----
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Forbidden");
  }

  // ---- Receber mensagens (Meta -> você) ----
  if (req.method === "POST") {
    // Responde logo 200 pra Meta não reenviar
    res.status(200).json({ ok: true });

    try {
      const body = req.body;

      const entry = body?.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;

      const messages = value?.messages;
      if (!messages || !Array.isArray(messages) || messages.length === 0) return;

      const msg = messages[0];
      const from = msg.from;

      // Só texto por enquanto (áudio depois)
      if (msg.type !== "text") {
        await sendTextMessage(from, "Por enquanto eu entendo só texto 🙂\n\nMe diga como posso ajudar (implante, resina estética, dor, limpeza etc).");
        return;
      }

      const userText = msg.text?.body || "";
      const aiText = await generateAIReply(userText);

      // WhatsApp tem limite por mensagem; se vier grande, corta.
      const finalText = aiText.length > 1500 ? aiText.slice(0, 1500) + "…" : aiText;

      await sendTextMessage(from, finalText);
    } catch (err) {
      console.error("Erro no webhook:", err);
    }
    return;
  }

  return res.status(405).send("Method Not Allowed");
}
