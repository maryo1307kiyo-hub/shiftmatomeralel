// api/game.js - ミニゲーム用スコア管理API
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

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

  // グループIDが1〜10（または1〜10の半角数字のみ）であるかを判定
  const isTargetGroup = /^(?:[1-9]|10)$/.test(groupId);
  if (!isTargetGroup) {
    return res.status(403).json({ error: 'Game not available' });
  }

  const key = `game:ranking:${groupId}`;

  // ランキング取得
  if (req.method === 'GET') {
    const rawData = await redisGet(key) || {};
    const ranking = Object.values(rawData)
      .map(item => ({ nickname: item.nickname, score: parseInt(item.score, 10) || 0 }))
      .sort((a, b) => b.score - a.score);
    return res.status(200).json({ ranking });
  }

  // スコア保存
  if (req.method === 'POST' && action === 'submit') {
    const { userId, nickname, score } = req.body;
    if (!userId || !nickname || score === undefined) return res.status(400).json({ error: 'Missing data' });

    const userKey = `${groupId}:${nickname}:${userId}`;
    let currentData = await redisGet(key) || {};
    const oldScore = currentData[userKey] ? (parseInt(currentData[userKey].score, 10) || 0) : 0;

    if (score > oldScore) {
      currentData[userKey] = { userId, nickname, score: parseInt(score, 10) };
      await redisSet(key, currentData);
    }
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
