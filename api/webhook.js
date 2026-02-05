export default async function handler(req, res) {
  // ====== VERIFICAÇÃO DO WEBHOOK (META) ======
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  }

  // ====== RECEBIMENTO DE MENSAGEM ======
  if (req.method === "POST") {
    try {
      const entry = req.body.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;

      const message = value?.messages?.[0];
      if (!message || message.type !== "text") {
        return res.status(200).json({ ok: true });
      }

      const from = message.from; // telefone do usuário
      const userText = message.text.body;

      console.log("📩 Incoming:", { from, userText });

      // ====== DELAY HUMANO (1.5s a 3.5s) ======
      const delay = Math.floor(Math.random() * 2000) + 1500;
      await new Promise(r => setTimeout(r, delay));

      // ====== OPENAI ======
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
Você é um assistente de atendimento premium de uma clínica odontológica no WhatsApp.
Objetivo: converter leads em agendamento de avaliação.

Regras:
- Seja humano, brasileiro, educado e direto
- Mensagens curtas
- Faça uma pergunta por vez
- Não dê diagnóstico nem preço fechado
- Se for urgência, oriente atendimento imediato
`
            },
            {
              role: "user",
              content: userText
            }
          ],
          temperature: 0.6
        })
      });

      const aiData = await aiResponse.json();
      const replyText =
        aiData.choices?.[0]?.message?.content ||
        "Pode me explicar um pouco melhor, por favor?";

      // ====== ENVIO PARA WHATSAPP ======
      const phoneNumberId = process.env.PHONE_NUMBER_ID;

      const sendResponse = await fetch(
        `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`,
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

      const sendResult = await sendResponse.json();
      console.log("📤 WhatsApp response:", sendResult);

      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error("❌ Error:", err);
      return res.status(200).json({ ok: true });
    }
  }

  return res.status(405).send("Method Not Allowed");
}
