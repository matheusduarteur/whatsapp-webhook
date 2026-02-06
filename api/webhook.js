const sessions = new Map(); // from -> { history: [], state: {}, _lastTs: number }

// Dedup (Meta pode reenviar evento)
const processed = new Map(); // msgId -> timestamp

function cleanupMap(map, ttlMs) {
  const now = Date.now();
  for (const [k, v] of map.entries()) {
    if (now - v > ttlMs) map.delete(k);
  }
}

function cleanupSessions(ttlMs = 6 * 60 * 60 * 1000) {
  const now = Date.now();
  for (const [k, v] of sessions.entries()) {
    const last = v?._lastTs || 0;
    if (last && now - last > ttlMs) sessions.delete(k);
  }
}

function seenRecently(msgId, ttlMs = 10 * 60 * 1000) {
  if (!msgId) return false;
  cleanupMap(processed, ttlMs);
  const now = Date.now();
  const ts = processed.get(msgId);
  if (ts && now - ts < ttlMs) return true;
  processed.set(msgId, now);
  return false;
}

function nowInSaoPaulo() {
  const fmt = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
  });
  return fmt.format(new Date());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function humanDelayMs(text) {
  const len = (text || "").length;
  const base = 900;
  const perChar = 14;
  const jitter = Math.floor(Math.random() * 700);
  const ms = base + len * perChar + jitter;
  return Math.min(5000, Math.max(1200, ms)); // 1.2s a 5s
}

function splitMessage(text) {
  const t = (text || "").trim();
  if (!t) return ["..."];
  if (t.length <= 320) return [t];

  const max1 = 320;
  let cut = t.lastIndexOf("\n", max1);
  if (cut < 120) cut = t.lastIndexOf(". ", max1);
  if (cut < 120) cut = max1;

  const p1 = t.slice(0, cut).trim();
  const p2 = t.slice(cut).trim();

  if (p2.length > 420) return [p1, p2.slice(0, 420).trim() + "…"];
  return [p1, p2];
}

function assertEnv() {
  const needed = ["VERIFY_TOKEN", "WHATSAPP_TOKEN", "PHONE_NUMBER_ID", "OPENAI_API_KEY"];
  const missing = needed.filter((k) => !process.env[k]);
  if (missing.length) throw new Error("Missing env vars: " + missing.join(", "));
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function sendWhatsAppText({ to, bodyText, trace }) {
  const url = `https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/messages`;

  const r = await fetchWithTimeout(
    url,
    {
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
    },
    12000
  );

  const dataText = await r.text();
  if (!r.ok) {
    console.log("❌ WhatsApp send error:", { trace, status: r.status, dataText: dataText.slice(0, 800) });
  } else {
    console.log("✅ WhatsApp sent:", { trace, status: r.status });
  }
  return { ok: r.ok, status: r.status, dataText };
}

// ---------- INTELIGÊNCIA (B) ----------

function detectIntent(userText) {
  const t = (userText || "").toLowerCase();

  // urgência/dor
  if (/(dor|inchad|inchaç|sangra|febre|pus|abscesso|latej|urg|emerg)/i.test(t)) return "dor";

  // implante
  if (/(implante|parafuso|osso|enxerto|coroa|prótese fixa|protes)/i.test(t)) return "implante";

  // clareamento
  if (/(clare|branquea|branco|mancha|amarel)/i.test(t)) return "clareamento";

  // resina estética
  if (/(resina|faceta|fechar espaço|diastema|estética|trocar restauração|forma|cor)/i.test(t)) return "resina";

  return "geral";
}

function pickNextQuestion(state) {
  const intent = state.intent || "geral";
  const data = state.data || {};

  // Urgência primeiro
  if (intent === "dor") {
    if (!data.dor_nivel) return "De 0 a 10, qual o nível da dor agora?";
    if (!data.tem_inchaco) return "Tem inchaço no rosto ou na gengiva?";
    if (!data.tem_febre) return "Teve febre nas últimas horas?";
    if (!data.local) return "É em qual dente/região: em cima ou embaixo?";
    // Se já coletou o básico, vai pra encaminhamento/agendamento
    return "Consigo te encaixar pra avaliação o quanto antes. Prefere manhã, tarde ou noite?";
  }

  if (intent === "implante") {
    if (!data.extraido) return "Você já extraiu o dente ou ainda está com ele?";
    if (!data.local) return "É em cima ou embaixo?";
    if (!data.tempo) return "Há quanto tempo foi a extração (ou o problema começou)?";
    if (!data.dor_hoje) return "Tem dor hoje?";
    return "Perfeito. Pra agendar a avaliação, você prefere manhã, tarde ou noite?";
  }

  if (intent === "resina") {
    if (!data.objetivo) return "Qual o objetivo principal: trocar restauração, fechar espaço ou melhorar forma/cor?";
    if (!data.qtd_dentes) return "É em quantos dentes, mais ou menos?";
    if (!data.quando) return "Você quer resolver isso o quanto antes ou está só pesquisando por enquanto?";
    return "Consigo te encaixar pra avaliação. Prefere manhã, tarde ou noite?";
  }

  if (intent === "clareamento") {
    if (!data.ja_fez) return "Você já fez clareamento antes?";
    if (!data.sensibilidade) return "Você tem sensibilidade nos dentes hoje?";
    return "Boa. Pra agendar a avaliação e ver o melhor método, prefere manhã, tarde ou noite?";
  }

  // geral
  if (!data.assunto) return "É sobre implante, resina estética, clareamento ou dor/urgência?";
  return "Perfeito. Prefere manhã, tarde ou noite para agendar uma avaliação?";
}

function updateStateFromUser(state, userText) {
  const t = (userText || "").toLowerCase();
  const intent = state.intent || "geral";
  const data = state.data || {};

  // Capturas simples (heurísticas)
  // Local: cima/baixo
  if (!data.local && /(em cima|superior|em cima)/i.test(t)) data.local = "cima";
  if (!data.local && /(embaixo|inferior|em baixo)/i.test(t)) data.local = "baixo";

  // Dor nível 0-10
  const mDor = t.match(/\b(10|[0-9])\b/);
  if (intent === "dor" && !data.dor_nivel && mDor) data.dor_nivel = mDor[1];

  // Sim/não para perguntas comuns
  if (/(sim|s|tenho|tá doendo|está doendo)/i.test(t)) {
    if (intent === "dor" && data.tem_inchaco === "pergunta_pendente") data.tem_inchaco = "sim";
    if (intent === "dor" && data.tem_febre === "pergunta_pendente") data.tem_febre = "sim";
    if (intent === "clareamento" && data.ja_fez === "pergunta_pendente") data.ja_fez = "sim";
    if (intent === "clareamento" && data.sensibilidade === "pergunta_pendente") data.sensibilidade = "sim";
    if (intent === "implante" && data.extraido === "pergunta_pendente") data.extraido = "sim";
    if (intent === "implante" && data.dor_hoje === "pergunta_pendente") data.dor_hoje = "sim";
  }
  if (/(não|nao|n)/i.test(t)) {
    if (intent === "dor" && data.tem_inchaco === "pergunta_pendente") data.tem_inchaco = "nao";
    if (intent === "dor" && data.tem_febre === "pergunta_pendente") data.tem_febre = "nao";
    if (intent === "clareamento" && data.ja_fez === "pergunta_pendente") data.ja_fez = "nao";
    if (intent === "clareamento" && data.sensibilidade === "pergunta_pendente") data.sensibilidade = "nao";
    if (intent === "implante" && data.extraido === "pergunta_pendente") data.extraido = "nao";
    if (intent === "implante" && data.dor_hoje === "pergunta_pendente") data.dor_hoje = "nao";
  }

  // Se usuário falou diretamente “é implante/resina/clareamento/dor”
  if (intent === "geral") {
    const detected = detectIntent(userText);
    if (detected !== "geral") state.intent = detected;
  }

  state.data = data;
  return state;
}

function markPending(state, nextQuestion) {
  // marca campos “pendentes” (pra capturar sim/não depois)
  const intent = state.intent || "geral";
  const data = state.data || {};

  if (intent === "dor") {
    if (/inchaço/i.test(nextQuestion) && !data.tem_inchaco) data.tem_inchaco = "pergunta_pendente";
    if (/febre/i.test(nextQuestion) && !data.tem_febre) data.tem_febre = "pergunta_pendente";
  }
  if (intent === "clareamento") {
    if (/já fez/i.test(nextQuestion) && !data.ja_fez) data.ja_fez = "pergunta_pendente";
    if (/sensibilidade/i.test(nextQuestion) && !data.sensibilidade) data.sensibilidade = "pergunta_pendente";
  }
  if (intent === "implante") {
    if (/já extraiu/i.test(nextQuestion) && !data.extraido) data.extraido = "pergunta_pendente";
    if (/dor hoje/i.test(nextQuestion) && !data.dor_hoje) data.dor_hoje = "pergunta_pendente";
  }

  state.data = data;
  return state;
}

async function getAIReply({ history, userText, trace, state }) {
  const spTime = nowInSaoPaulo();
  const intent = state.intent || "geral";
  const nextQuestion = pickNextQuestion(state);

  const system = `
Você é o atendimento PREMIUM (estilo secretária experiente) de uma clínica odontológica no WhatsApp.

REGRAS ABSOLUTAS
- NUNCA reinicie a conversa.
- NUNCA use “Oi, como posso ajudar?” como resposta automática.
- Evite saudações repetidas. Se já saudou, siga direto.
- Sempre responda contextual ao que o cliente escreveu.
- Faça UMA pergunta por vez (obrigatório).
- Mensagens curtas (1–2 frases). No máximo 1 emoji e só quando fizer sentido.
- Não invente informações (preço, endereço, promoções).
- Não diagnosticar nem prescrever medicamentos.

CONTEXTO OPERACIONAL
- Horário atual (São Paulo): ${spTime}
- Intenção detectada: ${intent}
- Estado atual (resumo): ${JSON.stringify(state.data || {})}
- Próxima pergunta obrigatória: "${nextQuestion}"

INSTRUÇÃO DE SAÍDA
- Responda em 1–2 frases e termine EXATAMENTE com a próxima pergunta obrigatória (sem adicionar segunda pergunta).
`.trim();

  const payload = {
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages: [
      { role: "system", content: system },
      ...history,
      { role: "user", content: userText },
    ],
    temperature: 0.45,
  };

  const r = await fetchWithTimeout(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
    15000
  );

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.log("❌ OpenAI error:", { trace, status: r.status, data: JSON.stringify(data).slice(0, 900) });
    return `Entendi. ${nextQuestion}`;
  }

  let reply = data?.choices?.[0]?.message?.content?.trim() || "";
  if (!reply) reply = `Entendi. ${nextQuestion}`;

  if (reply.length > 1200) reply = reply.slice(0, 1150).trim() + "…";

  return reply;
}

export default async function handler(req, res) {
  // ===== Verify (Meta) =====
  if (req.method === "GET") {
    const mode = req.query?.["hub.mode"];
    const token = req.query?.["hub.verify_token"];
    const challenge = req.query?.["hub.challenge"];

    if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Forbidden");
  }

  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    assertEnv();

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // ignora status de entrega/leitura
    if (value?.statuses?.length) return res.status(200).json({ ok: true });

    const msg = value?.messages?.[0];
    if (!msg) return res.status(200).json({ ok: true });

    const from = msg.from;
    const msgId = msg.id;
    const trace = `${from}:${msgId || "noid"}`;

    cleanupMap(processed, 10 * 60 * 1000);
    cleanupSessions();

    if (seenRecently(msgId)) {
      console.log("🔁 Duplicate ignored:", { trace });
      return res.status(200).json({ ok: true });
    }

    // ✅ ignora figurinha
    if (msg.type === "sticker") {
      console.log("🧷 Sticker ignored:", { trace });
      return res.status(200).json({ ok: true });
    }

    // Outros tipos (áudio/imagem/etc): pede texto
    if (msg.type !== "text") {
      const quick = "Consigo te ajudar 🙂 Me manda em texto o que você precisa (implante, resina, clareamento ou dor).";
      console.log("📩 Incoming non-text:", { trace, type: msg.type });
      await sleep(humanDelayMs(quick));
      await sendWhatsAppText({ to: from, bodyText: quick, trace });
      return res.status(200).json({ ok: true });
    }

    const userText = msg.text?.body?.trim() || "";
    if (!userText) return res.status(200).json({ ok: true });

    console.log("📩 Incoming:", { trace, userText });

    // Carrega/Cria sessão
    if (!sessions.has(from)) {
      sessions.set(from, { history: [], state: { intent: "geral", data: {} }, _lastTs: Date.now() });
    }
    const sess = sessions.get(from);
    sess._lastTs = Date.now();

    // Comandos de debug
    if (userText.toLowerCase() === "#reset") {
      sessions.delete(from);
      const ok = "Sessão resetada ✅ Pode mandar sua dúvida do zero.";
      await sleep(humanDelayMs(ok));
      await sendWhatsAppText({ to: from, bodyText: ok, trace });
      return res.status(200).json({ ok: true });
    }
    if (userText.toLowerCase() === "#status") {
      const s = sess?.state || {};
      const txt = `Status ✅\nintent: ${s.intent || "geral"}\ndata: ${JSON.stringify(s.data || {})}`;
      await sendWhatsAppText({ to: from, bodyText: txt, trace });
      return res.status(200).json({ ok: true });
    }

    // Atualiza intenção/estado com base no usuário
    if (!sess.state?.intent || sess.state.intent === "geral") {
      sess.state.intent = detectIntent(userText);
      if (sess.state.intent === "geral") sess.state.intent = sess.state.intent || "geral";
    }
    sess.state = updateStateFromUser(sess.state, userText);

    // Define a próxima pergunta e marca pendência (pra sim/não)
    const nq = pickNextQuestion(sess.state);
    sess.state = markPending(sess.state, nq);

    // OpenAI (com histórico + estado)
    const t0 = Date.now();
    const replyText = await getAIReply({
      history: sess.history,
      userText,
      trace,
      state: sess.state,
    });
    const aiMs = Date.now() - t0;

    // Salva histórico
    sess.history.push({ role: "user", content: userText });
    sess.history.push({ role: "assistant", content: replyText });
    if (sess.history.length > 18) sess.history.splice(0, sess.history.length - 18);

    // Envio com delay humano (reduz se OpenAI já demorou)
    const parts = splitMessage(replyText);
    const d1 = aiMs > 8000 ? 0 : humanDelayMs(parts[0]);

    await sleep(d1);
    await sendWhatsAppText({ to: from, bodyText: parts[0], trace });

    if (parts[1]) {
      const d2 = aiMs > 8000 ? 250 : 700 + Math.floor(Math.random() * 900);
      await sleep(d2);
      await sendWhatsAppText({ to: from, bodyText: parts[1], trace });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.log("❌ Handler error:", err);
    return res.status(200).json({ ok: true });
  }
}
