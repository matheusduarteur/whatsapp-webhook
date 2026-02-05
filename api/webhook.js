const sessions = new Map();

function nowInSaoPaulo() {
  const fmt = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
  });
  return fmt.format(new Date()); // "09:43"
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Delay proporcional ao tamanho + jitter, com limites seguros
function humanDelayMs(text) {
  const len = (text || "").length;
  const base = 900;          // mínimo
  const perChar = 14;        // ajuste fino (↑ mais lento / ↓ mais rápido)
  const jitter = Math.floor(Math.random() * 700); // 0–700ms
  const ms = base + len * perChar + jitter;
  return Math.min(5000, Math.max(1200, ms)); // 1.2s a 5s
}

// Divide mensagem longa em blocos "humanos"
function splitMessage(text) {
  const t = (text || "").trim();
  if (t.length <= 320) return [t];

  // quebra em até 2 partes para não virar spam
  const max1 = 320;
  let cut = t.lastIndexOf("\n", max1);
  if (cut < 120) cut = t.lastIndexOf(". ", max1);
  if (cut < 120) cut = max1;

  const p1 = t.slice(0, cut).trim();
  const p2 = t.slice(cut).trim();

  // se a 2ª parte ficar enorme, limita (pra não mandar 5 mensagens)
  if (p2.length > 420) {
    return [p1, p2.slice(0, 420).trim() + "…"];
  }

  return [p1, p2];
}

async function sendWhatsAppText(to, bodyText) {
  const url = `https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/messages`;

  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: bodyText },
    }),
  });

  const dataText = await r.text();
  if (!r.ok) {
    console.log("❌ WhatsApp send error:", r.status, dataText);
  } else {
    console.log("✅ WhatsApp sent:", r.status);
  }
  return { ok: r.ok, status: r.status, dataText };
}

async function getAIReply(history, userText) {
  const spTime = nowInSaoPaulo();

  const system = `
Você é o atendimento PREMIUM (estilo secretária experiente) de uma clínica odontológica no WhatsApp.
Hoje você está recebendo muitos contatos, então você precisa ser ágil, humano e objetivo — sem parecer robô.

REGRAS ABSOLUTAS
- NUNCA reinicie a conversa.
- NUNCA use “Oi, como posso ajudar?” como resposta automática.
- Evite saudações repetidas. Se já saudou, siga direto.
- Sempre responda de forma contextual ao que o cliente escreveu.
- Faça UMA pergunta por vez.
- Mensagens curtas (1–2 frases). No máximo 1 emoji e só quando fizer sentido.
- Não invente informações (endereço, preço, promoções) se não tiver no contexto.
- Não diagnosticar nem prescrever medicamentos.

OBJETIVO
- Entender rapidamente a necessidade do cliente.
- Fazer 2–4 perguntas de triagem (uma por vez).
- Conduzir naturalmente para agendar uma avaliação.

TRIAGEM (escolha conforme o caso)
- Implante: “Já extraiu ou ainda está com o dente?”, “Em cima ou embaixo?”, “Há quanto tempo?”, “Tem dor hoje?”
- Resina estética: “Qual o objetivo principal: trocar restauração, fechar espaço, melhorar forma/cor?”, “Quantos dentes?”
- Clareamento: “Já fez antes?”, “Tem sensibilidade?”
- Dor/urgência: “De 0 a 10 a dor?”, “Tem inchaço/febre?”
Se urgência (dor insuportável, sangramento forte, febre, inchaço facial, pus): orientar atendimento imediato e oferecer encaminhar para humano.

AGENDAMENTO
- Quando fizer sentido, peça preferência de dia e turno: manhã / tarde / noite.
- Fale como clínica premium: organizada, direta, mas acolhedora.

CONTEXTO
- Horário atual (São Paulo): ${spTime}
`.trim();

  const payload = {
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages: [
      { role: "system", content: system },
      ...history,
      { role: "user", content: userText },
    ],
    temperature: 0.55,
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.log("❌ OpenAI error:", r.status, JSON.stringify(data).slice(0, 1000));
    return "Entendi. Me diz só: é implante, estética em resina, clareamento ou dor?";
  }

  const reply = data?.choices?.[0]?.message?.content?.trim();
  return reply || "Entendi. Me diz só: é implante, estética em resina, clareamento ou dor?";
}

export default async function handler(req, res) {
  // ===== Webhook verify (Meta) =====
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Forbidden");
  }

  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // ignora status de entrega/leitura
    if (value?.statuses?.length) {
      return res.status(200).json({ ok: true });
    }

    const msg = value?.messages?.[0];
    if (!msg) {
      return res.status(200).json({ ok: true });
    }

    const from = msg.from;

    // Só texto por enquanto (evita travar)
    if (msg.type !== "text") {
      const quick = "Consigo te ajudar 🙂 Por enquanto, me manda em texto o que você precisa (implante, resina, clareamento ou dor).";
      await sleep(humanDelayMs(quick));
      await sendWhatsAppText(from, quick);
      return res.status(200).json({ ok: true });
    }

    const userText = msg.text?.body?.trim() || "";
    console.log("📩 Incoming:", { from, userText });

    // Sessão por número
    if (!sessions.has(from)) sessions.set(from, []);
    const history = sessions.get(from);

    // Gera resposta IA (com histórico)
    const replyText = await getAIReply(history, userText);

    // Salva histórico (limitado pra não crescer infinito)
    history.push({ role: "user", content: userText });
    history.push({ role: "assistant", content: replyText });
    if (history.length > 18) {
      // mantém só os últimos 18 itens (9 trocas)
      history.splice(0, history.length - 18);
    }

    // Delay humano antes de enviar
    const parts = splitMessage(replyText);

    // Parte 1
    await sleep(humanDelayMs(parts[0]));
    await sendWhatsAppText(from, parts[0]);

    // Parte 2 (se existir) com mini-delay extra
    if (parts[1]) {
      await sleep(700 + Math.floor(Math.random() * 900));
      await sendWhatsAppText(from, parts[1]);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.log("❌ Handler error:", err);
    return res.status(200).json({ ok: true });
  }
}
