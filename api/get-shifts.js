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

      // ===== 申請シフトのマージ処理 =====
      // 考え方：
      // ・申請ページ(bulk_edit)は「今開いてる申請ウィンドウ」の日付しか含まない
      // ・締め切りが過ぎた（ウィンドウが閉じた）日付の申請は、確定/不採用が出るまでキャッシュでキープ
      // ・ウィンドウがまだ開いてる日付は、取得した申請ページが正 → ページに無ければ本人取り消しとして消す
      const freshPending = pendingShifts; // 今回取得できた申請シフト（開いてるウィンドウ分）
      const cached = prevPendingCache[member.name] || [];
      const todayStr = jstToday();

      // 1) キャッシュのうち「ウィンドウが閉じた日付」だけ残す（過去日・確定済み・不採用は除去）
      const keptFromCache = cached.filter(s =>
        isWindowClosed(s.date) &&
        s.date >= todayStr &&
        !confirmedDates.has(s.date) &&
        !rejectedDates.has(s.date)
      );

      // 2) 今回取得分（開いてるウィンドウ）とマージ（日付重複はfresh優先）
      const freshDates = new Set(freshPending.map(s => s.date));
      const merged = [
        ...freshPending,
        ...keptFromCache.filter(s => !freshDates.has(s.date))
      ];

      pendingShifts = merged;
      prevPendingCache[member.name] = merged;

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

// JSTの今日の日付を "YYYY-MM-DD" で返す
function jstToday() {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

// そのシフト日付の申請ウィンドウが閉じているか（＝申請ページから消える時期を過ぎたか）
// ・16〜末日のシフト → 同月6日に申請ページが消える
// ・1〜15日のシフト → 前月21日に申請ページが消える
function isWindowClosed(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const nowY = jst.getUTCFullYear();
  const nowM = jst.getUTCMonth() + 1;
  const nowD = jst.getUTCDate();
  const nowNum = nowY * 10000 + nowM * 100 + nowD;

  let closeY, closeM;
  if (d >= 16) {
    // 同月6日に閉じる
    closeY = y; closeM = m;
    return nowNum >= closeY * 10000 + closeM * 100 + 6;
  } else {
    // 前月21日に閉じる
    closeM = m - 1; closeY = y;
    if (closeM === 0) { closeM = 12; closeY--; }
    return nowNum >= closeY * 10000 + closeM * 100 + 21;
  }
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
