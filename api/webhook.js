const sessions = new Map(); // from -> { history: [], state: {}, _lastTs }

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
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());
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
  return Math.min(5000, Math.max(700, ms)); // reduz mínimo pra ficar responsivo
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

/* =========================
   CALCULADORA (modo #calc)
   ========================= */

const DENSITY_KG_PER_L = 1.10;
const PI = Math.PI;

function parseNumberBR(s) {
  // aceita "12,5" ou "12.5" e remove espaços
  const t = (s || "").toString().trim().replace(/\s+/g, "");
  const norm = t.replace(",", ".");
  const n = Number(norm);
  return Number.isFinite(n) ? n : null;
}

function parseRatio(text) {
  // aceita "2:1" "2/1" "2x1"
  const t = (text || "").toLowerCase().replace(/\s+/g, "");
  const m = t.match(/^(\d+(\.\d+)?)[\:\/x](\d+(\.\d+)?)$/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[3]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;
  return { resinParts: a, hardenerParts: b }; // RESINA : ENDURECEDOR
}

function litersFromCm3(cm3) {
  return cm3 / 1000; // 1000 cm³ = 1 L
}

function kgFromLiters(liters) {
  return liters * DENSITY_KG_PER_L;
}

function gramsFromKg(kg) {
  return kg * 1000;
}

function formatKg(kg) {
  // 0.123 -> "0,12 kg"
  return `${kg.toFixed(2).replace(".", ",")} kg`;
}
function formatL(l) {
  return `${l.toFixed(3).replace(".", ",")} L`;
}
function formatG(g) {
  const rounded = Math.round(g);
  return `${rounded} g`;
}

function computeVolumeLiters(calc) {
  // calc = { shape, dims }
  const shape = calc.shape;

  if (shape === "retangulo") {
    const { c_cm, l_cm, a_cm } = calc;
    const cm3 = c_cm * l_cm * a_cm;
    return litersFromCm3(cm3);
  }

  if (shape === "cilindro") {
    const { diam_cm, a_cm } = calc;
    const r = diam_cm / 2;
    const cm3 = PI * r * r * a_cm;
    return litersFromCm3(cm3);
  }

  if (shape === "triangular") {
    // prisma triangular: (base * alturaTri / 2) * comprimento
    const { base_cm, alttri_cm, comp_cm } = calc;
    const cm3 = (base_cm * alttri_cm / 2) * comp_cm;
    return litersFromCm3(cm3);
  }

  if (shape === "camada") {
    // camada superficial: área (cm²) * espessura (mm)
    // cm² * mm -> converter para cm³:
    // 1 mm = 0,1 cm => volume_cm3 = area_cm2 * (esp_mm * 0,1)
    const { c_cm, l_cm, esp_mm } = calc;
    const area_cm2 = c_cm * l_cm;
    const volume_cm3 = area_cm2 * (esp_mm * 0.1);
    return litersFromCm3(volume_cm3);
  }

  return null;
}

function buildCalcMenu() {
  return (
`🧮 Calculadora de resina (Universidade da Resina)

Escolhe o formato:
1) Retângulo (C x L x A) — peça “quadrada/retangular”
2) Cilindro (diâmetro x altura)
3) Prisma triangular (base x altura do triângulo x comprimento)
4) Camada superficial (C x L x espessura em mm)

Responde só com o número (1 a 4), meu amigo/minha amiga 🙂`
  );
}

function calcNextPrompt(calc) {
  if (!calc.shape) return buildCalcMenu();

  if (calc.shape === "retangulo") {
    if (calc.c_cm == null) return "Me diga o COMPRIMENTO em cm (ex: 30).";
    if (calc.l_cm == null) return "Agora a LARGURA em cm (ex: 20).";
    if (calc.a_cm == null) return "Agora a ALTURA/ESPESSURA do vazamento em cm (ex: 2).";
  }

  if (calc.shape === "cilindro") {
    if (calc.diam_cm == null) return "Qual o DIÂMETRO em cm? (ex: 10)";
    if (calc.a_cm == null) return "Qual a ALTURA/PROFUNDIDADE em cm? (ex: 3)";
  }

  if (calc.shape === "triangular") {
    if (calc.base_cm == null) return "Qual a BASE do triângulo em cm? (ex: 12)";
    if (calc.alttri_cm == null) return "Qual a ALTURA do triângulo em cm? (ex: 8)";
    if (calc.comp_cm == null) return "Qual o COMPRIMENTO do prisma em cm? (ex: 40)";
  }

  if (calc.shape === "camada") {
    if (calc.c_cm == null) return "Me diga o COMPRIMENTO da área em cm (ex: 30).";
    if (calc.l_cm == null) return "Agora a LARGURA da área em cm (ex: 20).";
    if (calc.esp_mm == null) return "Qual a ESPESSURA da camada em mm? (ex: 1 ou 2)";
  }

  // Depois do volume, pedir proporção
  if (!calc.ratio) {
    return "Qual a proporção da sua resina? (RESINA:ENDURECEDOR) Ex: 1:1 ou 2:1";
  }

  return null;
}

function finishCalcMessage(calc) {
  const liters = computeVolumeLiters(calc);
  const kg = kgFromLiters(liters);
  const g = gramsFromKg(kg);

  const { resinParts, hardenerParts } = calc.ratio;
  const totalParts = resinParts + hardenerParts;

  const resin_g = (g * (resinParts / totalParts));
  const hard_g = (g * (hardenerParts / totalParts));

  const msg =
`✅ Cálculo pronto

📦 Volume: ${formatL(liters)}
⚖️ Peso aproximado (densidade 1,10 kg/L): ${formatKg(kg)} (${formatG(g)})

🧪 Proporção (RESINA:ENDURECEDOR) = ${resinParts}:${hardenerParts}
➡️ Resina: ${formatG(resin_g)}
➡️ Endurecedor: ${formatG(hard_g)}

💡 Dica: na prática pode variar. Se for madeira (ou tiver perda no copo/selagem), considera fazer ~10% a mais pra garantir.

Quer calcular outra peça? Digita #calc 🙂`;

  return msg;
}

function ensureSession(from) {
  if (!sessions.has(from)) {
    sessions.set(from, {
      history: [],
      state: {
        mode: "mentor", // "mentor" | "calc"
        calc: null,
      },
    });
  }
  const sess = sessions.get(from);
  sess._lastTs = Date.now();
  return sess;
}

/* =========================
   AGENTE MENTOR (OpenAI)
   ========================= */

async function getAIReply({ history, userText, trace }) {
  const spTime = nowInSaoPaulo();

  const system = `
Você é o Assistente Oficial da UNIVERSIDADE DA RESINA, do professor Matheus.
Você é um mentor técnico + amigo no WhatsApp: acolhedor, direto, prático e detalhista quando necessário.

TOM
- Pode usar "meu amigo/minha amiga" às vezes (não toda hora).
- Emojis com intenção (0–2 por mensagem).
- Estilo WhatsApp: curto por padrão. Se pedirem, aprofunda.

PRINCÍPIOS
- Madeira é viva (umidade/temperatura). Resina é química (proporção/mistura/espessura/ambiente).
- Pressa é inimiga da resina.
- Teste antes da peça final.
- Ambiente controlado = previsibilidade.
- 90% do acabamento nasce antes do lixamento.

BASE TÉCNICA (resumo)
- Resina baixa: selagem/camadas finas; não usar em grandes volumes.
- Média: versátil (tábuas/bandejas/peças médias).
- Alta: vazamentos altos (mesas); respeitar altura máxima por camada e tempo entre camadas.
- Madeira ideal 8–12% de umidade; madeira úmida causa bolhas/trincas/descolamento.
- Selagem reduz bolhas e economiza resina.
- Ambiente ideal 20–25°C; evitar vento/poeira/sol direto; base nivelada.
- Mistura em peso, devagar 3–5min raspando laterais/fundo; trocar de recipiente ajuda.
- Pigmento: pouco; excesso pode prejudicar cura.
- Bolhas: selagem + soprador rápido nos primeiros minutos; bolha interna não corrige depois.
- Lixamento comum: 80/120 -> 220/320 -> 400/600 -> 800 a 2000; polimento depois.
- Segurança: luvas, máscara, óculos, ventilação, longe de alimentos/crianças.

REGRAS
- Não invente dados específicos de marca/linha. Se precisar, peça rótulo/ficha técnica.
- Quando for recomendação geral, deixe claro ("como regra geral...").
- Termine com UMA pergunta prática que avance o caso.

Horário (SP): ${spTime}
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
    return "Entendi, meu amigo. Me diz só: qual peça você quer fazer e qual a altura do vazamento?";
  }

  const reply = data?.choices?.[0]?.message?.content?.trim();
  return reply || "Entendi, meu amigo. Me diz só: qual peça você quer fazer e qual a altura do vazamento?";
}

/* =========================
   HANDLER
   ========================= */

export default async function handler(req, res) {
  if (req.method === "GET") {
    const mode = req.query?.["hub.mode"];
    const token = req.query?.["hub.verify_token"];
    const challenge = req.query?.["hub.challenge"];
    if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) return res.status(200).send(challenge);
    return res.status(403).send("Forbidden");
  }

  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    assertEnv();

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const value = body?.entry?.[0]?.changes?.[0]?.value;

    // ignora status
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

    // ignora figurinha
    if (msg.type === "sticker") return res.status(200).json({ ok: true });

    // Outros tipos: pede texto
    if (msg.type !== "text") {
      const quick = "Consigo te ajudar 🙂 Me manda em texto sua dúvida ou digita #calc pra calcular resina.";
      await sleep(humanDelayMs(quick));
      await sendWhatsAppText({ to: from, bodyText: quick, trace });
      return res.status(200).json({ ok: true });
    }

    const userText = msg.text?.body?.trim() || "";
    if (!userText) return res.status(200).json({ ok: true });

    const sess = ensureSession(from);

    // comandos
    if (userText.toLowerCase() === "#reset") {
      sessions.delete(from);
      const ok = "Sessão resetada ✅ Pode mandar sua dúvida do zero.";
      await sleep(humanDelayMs(ok));
      await sendWhatsAppText({ to: from, bodyText: ok, trace });
      return res.status(200).json({ ok: true });
    }

    // entra no modo calc
    if (userText.toLowerCase() === "#calc") {
      sess.state.mode = "calc";
      sess.state.calc = { shape: null, ratio: null };
      const prompt = calcNextPrompt(sess.state.calc);
      await sleep(humanDelayMs(prompt));
      await sendWhatsAppText({ to: from, bodyText: prompt, trace });
      return res.status(200).json({ ok: true });
    }

    // se estiver em modo calc, processa o passo
    if (sess.state.mode === "calc" && sess.state.calc) {
      const calc = sess.state.calc;

      // escolher shape
      if (!calc.shape) {
        const n = userText.trim();
        if (n === "1") calc.shape = "retangulo";
        else if (n === "2") calc.shape = "cilindro";
        else if (n === "3") calc.shape = "triangular";
        else if (n === "4") calc.shape = "camada";
        else {
          const again = buildCalcMenu();
          await sendWhatsAppText({ to: from, bodyText: again, trace });
          return res.status(200).json({ ok: true });
        }

        const prompt = calcNextPrompt(calc);
        await sleep(humanDelayMs(prompt));
        await sendWhatsAppText({ to: from, bodyText: prompt, trace });
        return res.status(200).json({ ok: true });
      }

      // coleta medidas conforme shape
      const setNextNumber = (key) => {
        const v = parseNumberBR(userText);
        if (v == null || v <= 0) return false;
        calc[key] = v;
        return true;
      };

      if (calc.shape === "retangulo") {
        if (calc.c_cm == null) {
          if (!setNextNumber("c_cm")) {
            return res.status(200).json({ ok: true });
          }
        } else if (calc.l_cm == null) {
          if (!setNextNumber("l_cm")) return res.status(200).json({ ok: true });
        } else if (calc.a_cm == null) {
          if (!setNextNumber("a_cm")) return res.status(200).json({ ok: true });
        }
      }

      if (calc.shape === "cilindro") {
        if (calc.diam_cm == null) {
          if (!setNextNumber("diam_cm")) return res.status(200).json({ ok: true });
        } else if (calc.a_cm == null) {
          if (!setNextNumber("a_cm")) return res.status(200).json({ ok: true });
        }
      }

      if (calc.shape === "triangular") {
        if (calc.base_cm == null) {
          if (!setNextNumber("base_cm")) return res.status(200).json({ ok: true });
        } else if (calc.alttri_cm == null) {
          if (!setNextNumber("alttri_cm")) return res.status(200).json({ ok: true });
        } else if (calc.comp_cm == null) {
          if (!setNextNumber("comp_cm")) return res.status(200).json({ ok: true });
        }
      }

      if (calc.shape === "camada") {
        if (calc.c_cm == null) {
          if (!setNextNumber("c_cm")) return res.status(200).json({ ok: true });
        } else if (calc.l_cm == null) {
          if (!setNextNumber("l_cm")) return res.status(200).json({ ok: true });
        } else if (calc.esp_mm == null) {
          const v = parseNumberBR(userText);
          if (v == null || v <= 0) return res.status(200).json({ ok: true });
          calc.esp_mm = v;
        }
      }

      // se já tem medidas, pedir proporção
      const prompt = calcNextPrompt(calc);
      if (prompt) {
        // ainda falta algo
        if (!calc.ratio && (calc.c_cm != null || calc.diam_cm != null || calc.base_cm != null)) {
          // se estamos na etapa da proporção, parseia
          if (
            (calc.shape === "retangulo" && calc.c_cm != null && calc.l_cm != null && calc.a_cm != null) ||
            (calc.shape === "cilindro" && calc.diam_cm != null && calc.a_cm != null) ||
            (calc.shape === "triangular" && calc.base_cm != null && calc.alttri_cm != null && calc.comp_cm != null) ||
            (calc.shape === "camada" && calc.c_cm != null && calc.l_cm != null && calc.esp_mm != null)
          ) {
            // se a próxima pergunta for proporção, tenta parsear se o usuário já mandou ratio
            if (prompt.toLowerCase().includes("proporção")) {
              const ratio = parseRatio(userText);
              if (ratio) {
                calc.ratio = ratio;
              } else {
                // se ainda não tem ratio, manda pergunta de ratio
                await sleep(humanDelayMs(prompt));
                await sendWhatsAppText({ to: from, bodyText: prompt, trace });
                return res.status(200).json({ ok: true });
              }
            }
          }
        }

        // se ratio já veio agora, finaliza
        if (calc.ratio) {
          const done = finishCalcMessage(calc);
          sess.state.mode = "mentor";
          sess.state.calc = null;
          await sleep(humanDelayMs(done));
          await sendWhatsAppText({ to: from, bodyText: done, trace });
          return res.status(200).json({ ok: true });
        }

        // caso geral: manda o próximo prompt
        await sleep(humanDelayMs(prompt));
        await sendWhatsAppText({ to: from, bodyText: prompt, trace });
        return res.status(200).json({ ok: true });
      }

      // fallback (não deveria chegar aqui)
      sess.state.mode = "mentor";
      sess.state.calc = null;
      await sendWhatsAppText({ to: from, bodyText: "Beleza! Se quiser calcular outra peça, digita #calc 🙂", trace });
      return res.status(200).json({ ok: true });
    }

    // modo mentor (normal)
    const replyText = await getAIReply({ history: sess.history, userText, trace });

    sess.history.push({ role: "user", content: userText });
    sess.history.push({ role: "assistant", content: replyText });
    if (sess.history.length > 18) sess.history.splice(0, sess.history.length - 18);

    const parts = splitMessage(replyText);
    await sleep(humanDelayMs(parts[0]));
    await sendWhatsAppText({ to: from, bodyText: parts[0], trace });

    if (parts[1]) {
      await sleep(600);
      await sendWhatsAppText({ to: from, bodyText: parts[1], trace });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.log("❌ Handler error:", err);
    return res.status(200).json({ ok: true });
  }
}
