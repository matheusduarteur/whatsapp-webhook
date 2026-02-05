export default async function handler(req, res) {
  // ====== 1) Verificação do Webhook (GET) ======
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  }

  // ====== 2) Receber eventos (POST) ======
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const message = value?.messages?.[0];
    if (!message) {
      // Sem mensagem (status delivery, etc). Responde OK e sai.
      return res.status(200).json({ ok: true, ignored: "no_message" });
    }

    if (message.type !== "text") {
      return res.status(200).json({ ok: true, ignored: "non_text" });
    }

    const from = message.from; // número do usuário em formato 55...
    const userText = message.text?.body || "";

    console.log("📩 Incoming:", { from, userText });

    // ====== 3) Delay humano (ajusta aqui) ======
    const min = Number(process.env.DELAY_MIN_MS || 1200); // 1.2s
    const max = Number(process.env.DELAY_MAX_MS || 2800); // 2.8s
    const delayMs = Math.max(0, min) + Math.floor(Math.random() * Math.max(1, max - min + 1));

    if (delayMs > 0) {
      console.log("⏳ Delay(ms):", delayMs);
      await new Promise((r) => setTimeout(r, delayMs));
    }

    // ====== 4) Responder (WhatsApp Cloud API) ======
    const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
    const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

    if (!PHONE_NUMBER_ID || !WHATSAPP_TOKEN) {
      console.error("❌ Faltando envs:", {
        PHONE_NUMBER_ID: !!PHONE_NUMBER_ID,
        WHATSAPP_TOKEN: !!WHATSAPP_TOKEN,
      });
      return res.status(200).json({ ok: false, error: "missing_envs" });
    }

    const replyText = "Oi! 😊 Como posso te ajudar hoje?";

    const url = `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`;

    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: from,
        type: "text",
        text: { body: replyText },
      }),
    });

    const text = await r.text();
    console.log("📤 WhatsApp API status:", r.status);
    console.log("📤 WhatsApp API body:", text);

    // ====== 5) AGORA SIM responde 200 pra Meta ======
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("❌ Erro no webhook:", err);
    // Mesmo com erro, responde 200 pra Meta não ficar retry infinito
    return res.status(200).json({ ok: false });
  }
}
