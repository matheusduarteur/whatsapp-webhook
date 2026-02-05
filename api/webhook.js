// api/webhook.js
// WhatsApp Cloud API webhook + resposta com OpenAI (Vercel Serverless Function)

const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v20.0";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// =========================
// Helpers
// =========================
async function sendTextMessage(to, text) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`;

  const body = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    console.error("sendTextMessage error:", resp.status, data);
  }
  return { ok: resp.ok, status: resp.status, data };
}

function getIncomingMessageText(body) {
  // Padrão: entry[0].changes[0].value.messages[0].text.body
  try {
    const msg = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return null;

    if (msg.type === "text") return msg.text?.body || null;

    // Se quiser expandir depois (audio, image etc.), faz aqui.
    return null;
  } catch {
    return null;
  }
}

function getSenderWaId(body) {
  try {
    const msg = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    return msg?.from || null; // wa_id do usuário
  } catch {
    return null;
  }
}

function isEchoFromUs(body) {
  // Evita responder a mensagens "echo" (enviadas por você)
  // Nem sempre vem, mas quando vem ajuda.
  try {
    const msg = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    return Boolean(msg?.context?.from); // heurística leve
  } catch {
    return false;
  }
}

async function openaiReply(userText) {
  if (!OPENAI_API_KEY) {
    return "Estou com instabilidade no sistema agora. Pode tentar novamente em instantes?";
  }

  const systemPrompt = `
Você é um assistente premium de atendimento de uma clínica odontológica no WhatsApp.
Objetivo: converter leads (vindos de anúncios do Instagram/Facebook) em agendamento de avaliação.

Serviços: Implantes, estética em resina, limpeza, clareamento, aparelho, dor/urgência (triagem), outros.

Tom: humano, brasileiro, acolhedor e direto. Mensagens curtas. No máximo 1 emoji por mensagem. Faça UMA pergunta por vez.

Regras:
- Não diagnosticar nem prescrever medicamentos.
- Se urgência (dor insuportável, sangramento intenso, inchaço no rosto, febre, trauma forte, pus): orientar atendimento imediato e oferecer contato humano.
- Se pedir preço fechado: dizer que depende do caso e que a avaliação define o orçamento.
- Sempre buscar: nome + qual serviço + preferencia de dia/turno para agendar.
  `.trim();

  // Chamando OpenAI (Responses API)
  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: userText,
        },
      ],
    }),
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    console.error("OpenAI error:", resp.status, data);
    return "Tive um probleminha aqui pra responder agora. Pode repetir sua mensagem em 1 minuto?";
  }

  // Resposta vem em data.output_text na maioria dos casos
  const text = data.output_text || data?.output?.[0]?.content?.[0]?.text || "";
  return (text || "").trim() || "Perfeito. Qual seu nome, por favor?";
}

// =========================
// Handler (Vercel)
// =========================
export default async function handler(req, res) {
  try {
    // --------
    // GET: verificação do webhook (Meta)
    // --------
    if (req.method === "GET") {
      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];

      if (mode === "subscribe" && token && token === VERIFY_TOKEN) {
        return res.status(200).send(challenge);
      }
      return res.status(403).send("Forbidden");
    }

    // --------
    // POST: eventos (mensagens)
    // --------
    if (req.method === "POST") {
      const body = req.body;

      // Responder rápido para a Meta (boa prática)
      res.status(200).json({ ok: true });

      // Ignora se não for mensagem
      const incomingText = getIncomingMessageText(body);
      const from = getSenderWaId(body);

      if (!incomingText || !from) return;

      // Evita loop / echo
      if (isEchoFromUs(body)) return;

      // Se quiser um “fallback” quando começar:
      // if (incomingText.toLowerCase().includes("oi")) ...

      const aiText = await openaiReply(incomingText);

      // Envia resposta no WhatsApp
      await sendTextMessage(from, aiText);
      return;
    }

    return res.status(405).send("Method Not Allowed");
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).send("Internal Server Error");
  }
}
