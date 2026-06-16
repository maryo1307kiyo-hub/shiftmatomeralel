// api/game.js - ゲームスコア管理API

function jstNow(){
  return new Date(Date.now() + 9*60*60*1000);
}
function jstDateStr(){
  const d = jstNow();
  return d.toISOString().slice(0,10);
}
function jstTimeStr(){
  const d = jstNow();
  return d.toISOString().slice(11,16);
}

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

  const { action, groupId } = req.query;

  // GET: ランキング取得
  if (req.method === 'GET' && action === 'ranking') {
    if (!groupId) return res.status(400).json({ error: 'groupId required' });
    const gameType = req.query.gameType || 'lion';
    const scores = await redisGet(`game:ranking:${groupId}:${gameType}`) || [];
    // 今日の日付
    const today = jstDateStr();
    // 日次ランキング（今日のベスト）
    const dailyMap = {};
    for (const s of scores) {
      if (s.date === today) {
        if (!dailyMap[s.userId] || s.score > dailyMap[s.userId].score) {
          dailyMap[s.userId] = s;
        }
      }
    }
    // 全時間ベスト
    const allTimeMap = {};
    for (const s of scores) {
      if (!allTimeMap[s.userId] || s.score > allTimeMap[s.userId].score) {
        allTimeMap[s.userId] = s;
      }
    }
    const daily = Object.values(dailyMap).sort((a,b) => b.score - a.score);
    const allTime = Object.values(allTimeMap).sort((a,b) => b.score - a.score);
    return res.status(200).json({ daily, allTime });
  }

  // POST: スコア登録
  if (req.method === 'POST' && action === 'score') {
    const { userId, nickname, score, groupId: gid, gameType } = req.body;
    if (!userId || !nickname || !score || !gid) {
      return res.status(400).json({ error: 'missing fields' });
    }
    const type = gameType || 'lion';
    const key = `game:ranking:${gid}:${type}`;
    const scores = await redisGet(key) || [];
    const today = jstDateStr();
    const timeStr = jstTimeStr();
    scores.push({ userId, nickname, score: Math.floor(score), date: today, time: timeStr, ts: Date.now() });
    // 最大1000件保持
    if (scores.length > 1000) scores.splice(0, scores.length - 1000);
    await redisSet(key, scores);

    // 自己ベスト更新
    const pbKey = `game:pb:${userId}`;
    const pb = await redisGet(pbKey);
    if (!pb || score > pb.score) {
      await redisSet(pbKey, { score: Math.floor(score), date: today, time: jstTimeStr() });
    }

    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
