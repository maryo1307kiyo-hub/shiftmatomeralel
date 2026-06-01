// api/mypage.js - マイページデータ管理

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const UPSTASH_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

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

  const { action } = req.query;

  // GET: マイページデータ取得
  if (req.method === 'GET') {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const data = await redisGet(`mypage:${userId}`);
    if (!data) return res.status(404).json({ error: 'not found' });
    return res.status(200).json(data);
  }

  // POST: 登録・更新
  if (req.method === 'POST') {
    const body = req.body;

    // 新規登録
    if (action === 'register') {
      const { userId, nickname, groupId, hourlyWage, commute, color } = body;
      if (!userId || !nickname || !groupId) {
        return res.status(400).json({ error: 'userId, nickname, groupId required' });
      }
      if (!/^[a-zA-Z0-9_-]{6,}$/.test(userId)) {
        return res.status(400).json({ error: 'IDは英数字6文字以上で入力してください' });
      }

      // グループにそのニックネームが存在するか確認
      const members = await redisGet(`group:${groupId}`);
      if (!members) return res.status(404).json({ error: 'グループが見つかりません' });
      const member = members.find(m => m.name === nickname);
      if (!member) return res.status(404).json({ error: 'グループにそのニックネームが見つかりません' });

      const data = {
        userId, nickname, groupId,
        hourlyWage: parseInt(hourlyWage) || 0,
        commute: parseInt(commute) || 0,
        color: color || '#7799cc',
        createdAt: new Date().toISOString()
      };
      await redisSet(`mypage:${userId}`, data);
      return res.status(200).json(data);
    }

    // 設定更新
    if (action === 'update') {
      const { userId, hourlyWage, commute, color } = body;
      if (!userId) return res.status(400).json({ error: 'userId required' });
      const data = await redisGet(`mypage:${userId}`);
      if (!data) return res.status(404).json({ error: 'not found' });
      const updated = {
        ...data,
        hourlyWage: parseInt(hourlyWage) ?? data.hourlyWage,
        commute: parseInt(commute) ?? data.commute,
        color: color || data.color,
      };
      await redisSet(`mypage:${userId}`, updated);
      return res.status(200).json(updated);
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
