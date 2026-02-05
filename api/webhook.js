async function readJson(req) {
  return await new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); }
      catch { resolve({}); }
    });
  });
}

export default async function handler(req, res) {
  // GET: verificação do webhook
  if (req.method === "GET") {
    const mode = req.query["hub.mode"] ?? req.query["hub_mode"];
    const token = req.query["hub.verify_token"] ?? req.query["hub_verify_token"];
    const challenge = req.query["hub.challenge"] ?? req.query["hub_challenge"];

    if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Token inválido");
  }

  // POST: receber mensagens
  if (req.method === "POST") {
    const body = await readJson(req);

    const value = body?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];

    // Se não for mensagem (ex: status), só confirma
    if (!message) return res.status(200).send("EVENT_RECEIVED");

    const from = message.from;
    const phoneNumberId = value?.metadata?.phone_number_id;

    // Evita loop e falhas silenciosas
    if (!from || !phoneNumberId) return res.status(200).send("EVENT_RECEIVED");

    // Responde no WhatsApp
    const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;

    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.WHATSAPP_TOKEN}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: from,
        text: { body: "🤖 Assistente ativo!" },
      }),
    }).catch(() => {});

    return res.status(200).send("EVENT_RECEIVED");
  }

  return res.status(405).send("Method Not Allowed");
}
