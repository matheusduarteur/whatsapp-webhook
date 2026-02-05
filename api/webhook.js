export default async function handler(req, res) {
  // 1. Verificação do webhook (Meta)
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  }

  // 2. ACK imediato para a Meta (NUNCA remover isso)
  if (req.method === "POST") {
    res.status(200).json({ ok: true });

    try {
      const entry = req.body.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;

      const message = value?.messages?.[0];
      if (!message || message.type !== "text") return;

      const from = message.from;
      const userText = message.text.body;

      console.log("📩 Incoming:", { from, userText });

      // 3. Delay humano (2 a 4 segundos)
      const delayMs = 2000 + Math.floor(Math.random() * 2000);
      await new Promise((resolve) => setTimeout(resolve, delayMs));

      // 4. Resposta simples (pode trocar depois pelo agente/IA)
      const replyText =
        "Oi! 😊 Tudo bem? Me conta rapidinho como posso te ajudar hoje.";

      await fetch(
        `https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: from,
            type: "text",
            text: { body: replyText },
          }),
        }
      );

      console.log("✅ Mensagem enviada com delay");
    } catch (err) {
      console.error("❌ Erro no webhook:", err);
    }
  }
}
