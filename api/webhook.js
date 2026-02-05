// api/webhook.js  (CommonJS - compatível no Vercel sem framework)

const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v20.0";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const SYSTEM_PROMPT = `
Você é um assistente de atendimento premium de uma clínica odontológica no WhatsApp.
Objetivo: converter leads (vindos de anúncios do Instagram/Facebook) em agendamento de avaliação.

Serviços: Implantes, estética em resina, limpeza, clareamento, aparelho, dor/urgência (triagem), outros.

Tom: humano, brasileiro, acolhedor e direto. Mensagens curtas. No máximo 1 emoji por mensagem. Uma pergunta por vez.

Regras:
- Não diagnosticar e não prescrever medicamentos.
- Se urgência (dor insuportável, sangramento intenso, inchaço no rosto, febre, trauma forte, pus): orientar atendimento imediato e oferecer humano.
- Se pedir preço fechado: dizer que depende do caso e que a avaliação define o orçamento.
- Se a primeira mensagem já indicar o tema (ex.: "implante"), assuma o tema e confirme.

Fluxo:
1) Confirme tema + peça o nome.
2) Faça 2-3 perguntas rápidas (uma por vez) específicas do tema.
3) Puxe para agendamento pedindo dia + turno (manhã/tarde/noite).
4) Resuma e diga que a recepção confirma o melhor horário.
`;

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

function extractOutputText(data) {
  const out = data?.output;
  if (!Array.isArray(out)) return "";
  let text = "";
  for (const item of out) {
    if (item?.type === "message" && Array.isArray(item?.content)) {
      for (const c of item.content) {
        if (c?.type === "output_text" && typeof c?.text === "string") text += c.text;
      }
    }
  }
  return text.trim();
}

async function generateAIReply(userText) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY não configurada.");

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      instructions: SYSTEM_PROMPT,
      input: userText,
      max_output_tokens: 220
    })
  });

  const data = await resp.json();
  if (!resp.ok) {
    console.error("Erro OpenAI:", resp.status, data);
    throw new Error("Falha ao chamar OpenAI.");
  }

  return extractOutputText(data) || "Perfeito! Qual seu nome pra eu te ajudar a agendar 🙂";
}

module.exports = async function handler(req, res) {
  // Verify webhook
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
    return res.status(403).send("Forbidden");
  }

  // Receive messages
  if (req.method === "POST") {
    res.status(200).json({ ok: true });

    try {
      const body = req.body;
      const entry = body?.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;

      const messages = value?.messages;
      if (!messages?.length) return;

      const msg = messages[0];
      const from = msg.from;

      if (msg.type !== "text") {
        await sendTextMessage(from, "Por enquanto eu entendo só texto 🙂\n\nMe diga: implante, resina estética, dor, limpeza, clareamento etc.");
        return;
      }

      const userText = msg.text?.body || "";
      const aiText = await generateAIReply(userText);
      await sendTextMessage(from, aiText.length > 1500 ? aiText.slice(0, 1500) + "…" : aiText);
    } catch (err) {
      console.error("Erro no webhook:", err);
    }
    return;
  }

  return res.status(405).send("Method Not Allowed");
};
