const sessions = new Map();

export default async function handler(req, res) {
  // ===== VERIFICAÇÃO META =====
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  }

  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message || message.type !== "text") {
      return res.status(200).json({ ok: true });
    }

    const from = message.from;
    const userText = message.text.body.trim();

    console.log("📩 Incoming:", { from, userText });

    // ===== CONTROLE DE SESSÃO =====
    if (!sessions.has(from)) {
      sessions.set(from, []);
    }

    const history = sessions.get(from);

    // ===== DELAY HUMANO =====
    const delay = Math.floor(Math.random() * 2000) + 1500;
    await new Promise(r => setTimeout(r, delay));

    let replyText = "";

    // ===== PRIMEIRA MENSAGEM =====
    if (history.length === 0) {
      replyText = "Oi 😊 Posso te ajudar com implantes, estética ou outro tratamento?";
    } else {
      // ===== OPENAI =====
      const aiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: `
Você é um assistente de atendimento de uma clínica odontológica.
Seja direto, humano e não repita cumprimentos.
Faça UMA pergunta por vez.
Nunca reinicie a conversa.
`
            },
            ...history,
            { role: "user", content: userText }
          ],
          temperature: 0.5
        })
      });

      const aiData = await aiResponse.json();
      replyText =
        aiData.choices?.[0]?.message?.content ||
        "Pode me explicar um pouco melhor?";
    }

    // ===== SALVA HISTÓRICO =====
    history.push({ role: "user", content: userText });
    history.push({ role: "assistant", content: replyText });

    // ===== ENVIA WHATSAPP =====
    await fetch(
      `https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: from,
          type: "text",
          text: { body: replyText }
        })
      }
    );

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("❌ Error:", err);
    return res.status(200).json({ ok: true });
  }
}
