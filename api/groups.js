export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  const UPSTASH_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    return res.status(500).json({ error: 'DB not configured' });
  }

  async function redisGet(key) {
    const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : null;
  }

  async function redisSet(key, value) {
    await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(value)
    });
  }

  const { groupId, action } = req.query;
  if (!groupId) return res.status(400).json({ error: 'groupId required' });

  const key = `group:${groupId}`;

  if (req.method === 'GET') {
    const members = await redisGet(key);
    return res.status(200).json({ members: members || [] });
  }

  if (req.method === 'POST') {
    const body = req.body;
    let members = (await redisGet(key)) || [];

    if (action === 'add') {
      const { name, url } = body;
      if (!name || !url) return res.status(400).json({ error: 'name and url required' });
      if (!url.includes('ciftr.jp')) return res.status(403).json({ error: 'ciftr.jp only' });
      if (members.some(m => m.url === url)) return res.status(409).json({ error: 'already exists' });
      members.push({ name, url });
      await redisSet(key, members);
      return res.status(200).json({ members });
    }

    if (action === 'remove') {
      members = members.filter(m => m.url !== body.url);
      await redisSet(key, members);
      return res.status(200).json({ members });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
