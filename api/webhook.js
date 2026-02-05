export default function handler(req, res) {
  if (req.method === "GET") {
    const mode = req.query["hub.mode"] ?? req.query["hub_mode"] ?? null;
    const token = req.query["hub.verify_token"] ?? req.query["hub_verify_token"] ?? null;
    const challenge = req.query["hub.challenge"] ?? req.query["hub_challenge"] ?? null;

    if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Token inválido");
  }

  if (req.method === "POST") {
    return res.status(200).send("EVENT_RECEIVED");
  }

  return res.status(405).send("Method Not Allowed");
}
