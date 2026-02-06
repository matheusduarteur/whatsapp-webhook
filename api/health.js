export default function handler(req, res) {
  const required = ["VERIFY_TOKEN", "WHATSAPP_TOKEN", "PHONE_NUMBER_ID", "OPENAI_API_KEY"];
  const missing = required.filter((k) => !process.env[k]);

  const summary = {
    ok: missing.length === 0,
    missing,
    has_openai_model: !!process.env.OPENAI_MODEL,
    node_env: process.env.NODE_ENV || null,
    time_utc: new Date().toISOString(),
  };

  res.status(summary.ok ? 200 : 500).json(summary);
}
