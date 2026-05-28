// api/get-shifts.js - キャッシュ付きシフト取得API

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

  const { groupId, force } = req.query;
  if (!groupId) return res.status(400).json({ error: 'groupId required' });

  // キャッシュキー
  const cacheKey = `shifts:${groupId}`;

  // 強制更新でない場合はキャッシュを確認
  if (force !== '1') {
    const cached = await redisGet(cacheKey);
    if (cached && !shouldRefresh(cached.cachedAt)) {
      return res.status(200).json({ ...cached, fromCache: true });
    }
  }

  // メンバーリスト取得
  const membersKey = `group:${groupId}`;
  const members = await redisGet(membersKey);
  if (!members || members.length === 0) {
    return res.status(200).json({ results: [], cachedAt: null });
  }

  // 全員分のシフトを取得
  const results = await Promise.all(members.map(async (member, idx) => {
    try {
      const apiUrl = `${getBaseUrl(req)}/api/fetch-shift?url=${encodeURIComponent(member.url)}`;
      const r = await fetch(apiUrl);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      return { name: member.name, colorIdx: idx, ...d };
    } catch(e) {
      return { name: member.name, colorIdx: idx, error: e.message, shifts: [], pendingShifts: [] };
    }
  }));

  const now = new Date().toISOString();
  const data = { results, cachedAt: now, fromCache: false };
  await redisSet(cacheKey, data);

  return res.status(200).json(data);
}

// 半月ごとに自動更新（1日と16日を超えたら）
function shouldRefresh(cachedAt) {
  if (!cachedAt) return true;
  const cached = new Date(cachedAt);
  const now = new Date();

  // キャッシュと現在で「期」が変わったか確認
  // 期: 1〜15日 = 前半, 16〜末日 = 後半
  const cachedPeriod = getPeriod(cached);
  const nowPeriod = getPeriod(now);

  return cachedPeriod !== nowPeriod;
}

function getPeriod(date) {
  const y = date.getFullYear();
  const m = date.getMonth();
  const half = date.getDate() <= 15 ? 0 : 1;
  return `${y}-${m}-${half}`;
}

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}
