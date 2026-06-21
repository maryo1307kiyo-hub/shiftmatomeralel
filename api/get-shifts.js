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

  const cacheKey = `shifts:${groupId}`;
  const pendingCacheKey = `pending:${groupId}`;

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

  // 前回の申請シフトキャッシュを取得（申請ページが消えた期間のバックアップ）
  const prevPendingCache = await redisGet(pendingCacheKey) || {};
  const prevCache = await redisGet(cacheKey);
  const lastCachedAt = prevCache ? prevCache.cachedAt : null;

  // 全員分のシフトを取得
  const results = await Promise.all(members.map(async (member, idx) => {
    try {
      const apiUrl = `${getBaseUrl(req)}/api/fetch-shift?url=${encodeURIComponent(member.url)}`;
      const r = await fetch(apiUrl);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();

      // 申請シフトの処理
      let pendingShifts = d.pendingShifts || [];
      const rejectedShifts = d.rejectedShifts || [];
      const confirmedDates = new Set((d.shifts || []).map(s => s.date));
      const rejectedDates = new Set(rejectedShifts.map(s => s.date));

      if (pendingShifts.length > 0) {
        // 申請ページが取得できた → キャッシュを更新
        prevPendingCache[member.name] = pendingShifts;
      } else if (prevPendingCache[member.name] && isDeadlinePeriod(lastCachedAt)) {
        // 申請ページが空 かつ 締め切りタイミング（6日or21日通過後）→ キャッシュを引き継ぐ
        // ただし確定済みや不採用（---）になった日付は除外
        pendingShifts = prevPendingCache[member.name].filter(s =>
          !confirmedDates.has(s.date) && !rejectedDates.has(s.date)
        );
      } else {
        // それ以外（本人が自分で取り消した）→ キャッシュも消す
        delete prevPendingCache[member.name];
      }

      return { name: member.name, colorIdx: idx, ...d, pendingShifts };
    } catch(e) {
      return { name: member.name, colorIdx: idx, error: e.message, shifts: [], pendingShifts: [], rejectedShifts: [] };
    }
  }));

  // 申請キャッシュを保存
  await redisSet(pendingCacheKey, prevPendingCache);

  const now = new Date().toISOString();
  const data = { results, cachedAt: now, fromCache: false };
  await redisSet(cacheKey, data);

  return res.status(200).json(data);
}

// 前回キャッシュ取得時から6日or21日の締め切りをまたいだかどうか
function isDeadlinePeriod(lastCachedAt) {
  if (!lastCachedAt) return false;
  const cached = new Date(lastCachedAt);
  const now = new Date();

  // 6日と21日が「締め切り日」
  // キャッシュ時点と今で、直近の締め切り日が変わってたらtrue
  const getLastDeadline = (date) => {
    const y = date.getFullYear();
    const m = date.getMonth();
    const d = date.getDate();
    if (d >= 21) return new Date(y, m, 21).getTime();
    if (d >= 6)  return new Date(y, m, 6).getTime();
    // 1〜5日は前月21日
    return new Date(y, m - 1, 21).getTime();
  };

  return getLastDeadline(now) > getLastDeadline(cached);
}

// 半月ごとに自動更新（6日と21日を超えたら）
function shouldRefresh(cachedAt) {
  if (!cachedAt) return true;
  const cached = new Date(cachedAt);
  const now = new Date();
  const cachedPeriod = getPeriod(cached);
  const nowPeriod = getPeriod(now);
  return cachedPeriod !== nowPeriod;
}

function getPeriod(date) {
  const y = date.getFullYear();
  const m = date.getMonth();
  const d = date.getDate();
  const half = d <= 6 ? 0 : d <= 21 ? 1 : 2;
  return `${y}-${m}-${half}`;
}

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}
