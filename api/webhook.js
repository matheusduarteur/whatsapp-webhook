export default function handler(req, res) {
  const mode = req.query["hub.mode"] ?? req.query["hub_mode"] ?? null;
  const token = req.query["hub.verify_token"] ?? req.query["hub_verify_token"] ?? null;
  const challenge = req.query["hub.challenge"] ?? req.query["hub_challenge"] ?? null;

  const envToken = process.env.VERIFY_TOKEN;

  return res.status(200).json({
    got: {
      mode,
      token_value: token,
      challenge
    },
    env: {
      verify_token_present: !!envToken,
      verify_token_length: envToken ? String(envToken).length : 0
    },
    match: token === envToken
  });
}
