export default async function handler(req, res) {
  if (req.method === "GET") return res.status(200).send("Webhook OK");
  return res.status(200).json({ ok: true });
}
