function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function humanDelayMs(text) {
  const base = 700; // ms mínimo
  const perChar = 14; // ms por caractere (aumenta = mais lento)
  const jitter = Math.floor(Math.random() * 600); // 0–600ms aleatório
  const ms = base + (text?.length || 0) * perChar + jitter;
  return Math.min(3500, Math.max(900, ms)); // trava entre 0.9s e 3.5s
}

export default async function handler(req, res) {
  // ===============================
  // 1) VERIFICAÇÃO DO WEBHOOK (GET)
  // ===============================
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Forbidden");
  }

  // ===============================
  // 2) RECEBENDO MENSAGENS (POST)
  // ===============================
  if (req.method === "POST") {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    // ✅ Sempre responde 200 pra Meta não reenviar
    res.status(200).json({ ok: true });

    // Ignora status de entrega/leitura
    if (!message || value?.statuses) return;

    const from = message.from;

    // Se não for texto (áudio, imagem etc), responde algo padrão
    let userText = "";
    if (message.type === "text") {
      userText = message.text?.body || "";
    } else {
      const quick =
        "Consigo te ajudar 🙂 Por enquanto, me manda em texto: implante, estética em resina, limpeza ou clareamento.";
      await sleep(humanDelayMs(quick));
      await fetch(
        `https://graph.facebook.com/v20.0/${process.env.PHONE_NUMBER_ID}/messages`,
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
            text: { body: quick },
          }),
        }
      );
      return;
    }

    console.log("📩 Mensagem recebida:", userText);

    // ===============================
    // 3) RESPOSTA SIMPLES COM MENU
    // ===============================
    const reply =
      "Oi! 😊 Sou o assistente da clínica.\n\n" +
      "Me diga como posso te ajudar:\n" +
      "1️⃣ Implantes\n" +
      "2️⃣ Estética em resina\n" +
      "3️⃣ Limpeza\n" +
      "4️⃣ Clareamento";

    // ✅ Delay humano antes de enviar
    await sleep(humanDelayMs(reply));

    // ===============================
    // 4) ENVIA MENSAGEM
    // ===============================
    const r = await fetch(
      `https://graph.facebook.com/v20.0/${process.env.PHONE_NUMBER_ID}/messages`,
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
          text: { body: reply },
        }),
      }
    );

    const data = await r.json().catch(() => ({}));
    if (!r.ok) console.log("❌ WhatsApp send error:", r.status, data);
    else console.log("✅ WhatsApp sent:", data);

    return;
  }

  return res.status(405).send("Method Not Allowed");
}
