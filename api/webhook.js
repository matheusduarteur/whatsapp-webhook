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
  const base = 800;
  const perChar = 10;
  const jitter = Math.floor(Math.random() * 600);
  const ms = base + len * perChar + jitter;
  return Math.min(4500, Math.max(650, ms));
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

// ---- Parsers de unidade (m/cm/mm, kg/g) ----

function normText(s) {
  return (s || "")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(",", ".");
}

function parseNumberOnly(s) {
  const t = normText(s).replace(/[^0-9.\-]/g, "");
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// Converte comprimento para cm
function parseLengthToCm(input) {
  // aceita: "3m", "2.5 m", "30cm", "120", "45 mm"
  const t = normText(input);

  // pega número + unidade opcional
  const m = t.match(/(-?\d+(\.\d+)?)(\s*)(mm|cm|m)?/);
  if (!m) return null;

  const val = Number(m[1]);
  if (!Number.isFinite(val) || val <= 0) return null;

  const unit = (m[4] || "").toLowerCase();

  if (unit === "m") return val * 100;
  if (unit === "mm") return val / 10;
  // default = cm
  return val;
}

// Converte espessura para cm (aceita mm/cm/m)
function parseThicknessToCm(input) {
  return parseLengthToCm(input); // mesma lógica serve
}

// Converte peso para gramas
function parseWeightToG(input) {
  // aceita: "1kg", "0.5 kg", "500g", "120 g", "1000"
  const t = normText(input);

  // captura número + unidade (kg/g) opcional
  const m = t.match(/(-?\d+(\.\d+)?)(\s*)(kg|g)?/);
  if (!m) return null;

  const val = Number(m[1]);
  if (!Number.isFinite(val) || val <= 0) return null;

  const unit = (m[4] || "").toLowerCase();
  if (unit === "kg") return val * 1000;
  // default = g
  return val;
}

// tenta ler 2 pesos na mesma mensagem (kit)
function parseKitWeights(text) {
  // Ex: "1kg e 500g", "1000g 120g", "1.2kg / 300g"
  const t = normText(text);

  // pega todos os "n + unidade"
  const matches = [...t.matchAll(/(\d+(\.\d+)?)(\s*)(kg|g)\b/g)];
  if (matches.length >= 2) {
    const resinG = parseWeightToG(matches[0][0]);
    const hardG = parseWeightToG(matches[1][0]);
    if (resinG && hardG) return { resinG, hardG };
  }

  // fallback: se vier "1000 120" sem unidade, não arrisca
  return null;
}

// ratio direto (fallback)
function parseRatio(text) {
  const t = normText(text).replace(/\s+/g, "");
  const m = t.match(/^(\d+(\.\d+)?)[\:\/x](\d+(\.\d+)?)$/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[3]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;
  return { resinParts: a, hardenerParts: b }; // RESINA : ENDURECEDOR
}

// ---- Cálculos ----

function litersFromCm3(cm3) {
  return cm3 / 1000;
}

function kgFromLiters(liters) {
  return liters * DENSITY_KG_PER_L;
}

function formatKg(kg) {
  return `${kg.toFixed(2).replace(".", ",")} kg`;
}

function formatG(g) {
  return `${Math.round(g)} g`;
}

function computeVolumeLiters(calc) {
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
    const { base_cm, alttri_cm, comp_cm } = calc;
    const cm3 = (base_cm * alttri_cm / 2) * comp_cm;
    return litersFromCm3(cm3);
  }

  if (shape === "camada") {
    // área (cm²) * espessura (cm) => cm³
    const { c_cm, l_cm, esp_cm } = calc;
    const area_cm2 = c_cm * l_cm;
    const cm3 = area_cm2 * esp_cm;
    return litersFromCm3(cm3);
  }

  return null;
}

function buildCalcMenu() {
  return (
`🧮 Calculadora de resina

Escolhe o formato:
1) Retângulo (C x L x A)
2) Cilindro (diâmetro x altura)
3) Prisma triangular (base x altura do triângulo x comprimento)
4) Camada superficial (C x L x espessura)

📌 Pode mandar medidas em cm OU m (ex: 3m). Espessura pode ser mm (ex: 2mm).
Responde só com o número (1 a 4) 🙂`
  );
}

function calcNextPrompt(calc) {
  if (!calc.shape) return buildCalcMenu();

  if (calc.shape === "retangulo") {
    if (calc.c_cm == null) return "Me diga o COMPRIMENTO (ex: 30cm ou 3m).";
    if (calc.l_cm == null) return "Agora a LARGURA (ex: 20cm ou 0,8m).";
    if (calc.a_cm == null) return "Agora a ALTURA/ESPESSURA do vazamento (ex: 2cm ou 20mm).";
  }

  if (calc.shape === "cilindro") {
    if (calc.diam_cm == null) return "Qual o DIÂMETRO? (ex: 10cm ou 0,3m)";
    if (calc.a_cm == null) return "Qual a ALTURA/PROFUNDIDADE? (ex: 3cm ou 30mm)";
  }

  if (calc.shape === "triangular") {
    if (calc.base_cm == null) return "Qual a BASE do triângulo? (ex: 12cm)";
    if (calc.alttri_cm == null) return "Qual a ALTURA do triângulo? (ex: 8cm)";
    if (calc.comp_cm == null) return "Qual o COMPRIMENTO do prisma? (ex: 40cm ou 1,2m)";
  }

  if (calc.shape === "camada") {
    if (calc.c_cm == null) return "Me diga o COMPRIMENTO da área (ex: 30cm ou 1m).";
    if (calc.l_cm == null) return "Agora a LARGURA da área (ex: 20cm ou 0,5m).";
    if (calc.esp_cm == null) return "Qual a ESPESSURA da camada? (ex: 1mm, 2mm ou 0,2cm)";
  }

  // Kit para descobrir proporção (universal)
  if (!calc.kit) {
    return (
`Agora me diga o KIT que você comprou (pra eu achar a proporção certinha):

➡️ Quanto veio de RESINA e quanto veio de ENDURECEDOR?
Exemplos:
- "1kg e 500g"
- "1000g e 120g"
- "1,2kg e 300g"`
    );
  }

  return null;
}

function finishCalcMessage(calc) {
  const liters = computeVolumeLiters(calc);
  const kgTotal = kgFromLiters(liters);
  const gTotal = kgTotal * 1000;

  // Proporção pelo kit
  const resinParts = calc.kit.resinG;
  const hardParts = calc.kit.hardG;
  const totalParts = resinParts + hardParts;

  const resin_g = gTotal * (resinParts / totalParts);
  const hard_g = gTotal * (hardParts / totalParts);

  const ratioApprox = (resinParts / hardParts);
  const ratioText = ratioApprox > 0 ? `≈ ${ratioApprox.toFixed(2).replace(".", ",")}:1` : "—";

  const msg =
`✅ Cálculo pronto

⚖️ Total aproximado: ${formatKg(kgTotal)} (${formatG(gTotal)})

🧪 Mistura (com base no seu KIT):
- Resina: ${formatG(resin_g)}
- Endurecedor: ${formatG(hard_g)}
(razão RESINA:ENDURECEDOR ${ratioText})

💡 Dica rápida: se for madeira (selagem fraca, frestas, perda no copo), faz ~10% a mais pra garantir. Se for molde silicone bem fechado, dá pra seguir mais “no alvo”.

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
- Madeira ideal 8–12% umidade; madeira úmida causa bolhas/trincas/descolamento.
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
- Se o aluno quiser calcular resina, oriente: "digita #calc".

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

    if (value?.statuses?.length) return res.status(200).json({ ok: true });

    const msg = value?.messages?.[0];
    if (!msg) return res.status(200).json({ ok: true });

    const from = msg.from;
    const msgId = msg.id;
    const trace = `${from}:${msgId || "noid"}`;

    cleanupMap(processed, 10 * 60 * 1000);
    cleanupSessions();

    if (seenRecently(msgId)) return res.status(200).json({ ok: true });

    if (msg.type === "sticker") return res.status(200).json({ ok: true });

    if (msg.type !== "text") {
      const quick = "Consigo te ajudar 🙂 Me manda em texto sua dúvida ou digita #calc pra calcular resina.";
      await sleep(humanDelayMs(quick));
      await sendWhatsAppText({ to: from, bodyText: quick, trace });
      return res.status(200).json({ ok: true });
    }

    const userText = msg.text?.body?.trim() || "";
    if (!userText) return res.status(200).json({ ok: true });

    const sess = ensureSession(from);

    if (userText.toLowerCase() === "#reset") {
      sessions.delete(from);
      const ok = "Sessão resetada ✅ Pode mandar sua dúvida do zero.";
      await sleep(humanDelayMs(ok));
      await sendWhatsAppText({ to: from, bodyText: ok, trace });
      return res.status(200).json({ ok: true });
    }

    if (userText.toLowerCase() === "#calc") {
      sess.state.mode = "calc";
      sess.state.calc = { shape: null, kit: null };
      const prompt = calcNextPrompt(sess.state.calc);
      await sleep(humanDelayMs(prompt));
      await sendWhatsAppText({ to: from, bodyText: prompt, trace });
      return res.status(200).json({ ok: true });
    }

    // MODO CALC
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

      // coleta medidas
      const setLen = (key, parserFn) => {
        const v = parserFn(userText);
        if (v == null || v <= 0) return false;
        calc[key] = v;
        return true;
      };

      if (calc.shape === "retangulo") {
        if (calc.c_cm == null) {
          if (!setLen("c_cm", parseLengthToCm)) return res.status(200).json({ ok: true });
        } else if (calc.l_cm == null) {
          if (!setLen("l_cm", parseLengthToCm)) return res.status(200).json({ ok: true });
        } else if (calc.a_cm == null) {
          if (!setLen("a_cm", parseThicknessToCm)) return res.status(200).json({ ok: true });
        }
      }

      if (calc.shape === "cilindro") {
        if (calc.diam_cm == null) {
          if (!setLen("diam_cm", parseLengthToCm)) return res.status(200).json({ ok: true });
        } else if (calc.a_cm == null) {
          if (!setLen("a_cm", parseThicknessToCm)) return res.status(200).json({ ok: true });
        }
      }

      if (calc.shape === "triangular") {
        if (calc.base_cm == null) {
          if (!setLen("base_cm", parseLengthToCm)) return res.status(200).json({ ok: true });
        } else if (calc.alttri_cm == null) {
          if (!setLen("alttri_cm", parseLengthToCm)) return res.status(200).json({ ok: true });
        } else if (calc.comp_cm == null) {
          if (!setLen("comp_cm", parseLengthToCm)) return res.status(200).json({ ok: true });
        }
      }

      if (calc.shape === "camada") {
        if (calc.c_cm == null) {
          if (!setLen("c_cm", parseLengthToCm)) return res.status(200).json({ ok: true });
        } else if (calc.l_cm == null) {
          if (!setLen("l_cm", parseLengthToCm)) return res.status(200).json({ ok: true });
        } else if (calc.esp_cm == null) {
          // aqui a pessoa pode mandar mm/cm/m, tudo vira cm
          if (!setLen("esp_cm", parseThicknessToCm)) return res.status(200).json({ ok: true });
        }
      }

      // Se medidas completas e ainda não tem kit, pedir kit e tentar parsear
      const measuresComplete =
        (calc.shape === "retangulo" && calc.c_cm != null && calc.l_cm != null && calc.a_cm != null) ||
        (calc.shape === "cilindro" && calc.diam_cm != null && calc.a_cm != null) ||
        (calc.shape === "triangular" && calc.base_cm != null && calc.alttri_cm != null && calc.comp_cm != null) ||
        (calc.shape === "camada" && calc.c_cm != null && calc.l_cm != null && calc.esp_cm != null);

      if (measuresComplete && !calc.kit) {
        // tenta interpretar a mensagem atual como kit (se o usuário já mandou)
        const kit = parseKitWeights(userText);
        if (kit) {
          calc.kit = kit;
        } else {
          const prompt = calcNextPrompt(calc);
          await sleep(humanDelayMs(prompt));
          await sendWhatsAppText({ to: from, bodyText: prompt, trace });
          return res.status(200).json({ ok: true });
        }
      }

      // Se ainda não tem kit, mas já estamos na etapa dele, parseia
      if (measuresComplete && !calc.kit) {
        const kit = parseKitWeights(userText);
        if (kit) calc.kit = kit;
      }

      // finaliza se tem kit
      if (measuresComplete && calc.kit) {
        const done = finishCalcMessage(calc);
        sess.state.mode = "mentor";
        sess.state.calc = null;
        await sleep(humanDelayMs(done));
        await sendWhatsAppText({ to: from, bodyText: done, trace });
        return res.status(200).json({ ok: true });
      }

      // ainda falta algo -> pergunta próxima etapa
      const prompt = calcNextPrompt(calc);
      await sleep(humanDelayMs(prompt));
      await sendWhatsAppText({ to: from, bodyText: prompt, trace });
      return res.status(200).json({ ok: true });
    }

    // MODO MENTOR
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
