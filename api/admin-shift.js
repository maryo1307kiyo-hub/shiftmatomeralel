// api/admin-shift.js - 管理者専用：シフト申請パスワードリセット

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const UPSTASH_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

  if (!ADMIN_PASSWORD) return res.status(500).json({ error: 'ADMIN_PASSWORD not configured' });

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

  async function redisDel(key) {
    await fetch(`${UPSTASH_URL}/del/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
  }

  // GET: リセットフラグ確認（各自のスマホから呼ばれる）
  if (req.method === 'GET' && req.query.action === 'check-reset') {
    const { groupId, name } = req.query;
    if (!groupId || !name) return res.status(400).json({ error: 'missing fields' });
    const flag = await redisGet(`apply-reset:${groupId}:${name}`);
    return res.status(200).json({ reset: !!flag });
  }

  // GET: リセットフラグを消す（初回設定完了後に呼ばれる）
  if (req.method === 'GET' && req.query.action === 'clear-reset') {
    const { groupId, name } = req.query;
    if (!groupId || !name) return res.status(400).json({ error: 'missing fields' });
    await redisDel(`apply-reset:${groupId}:${name}`);
    return res.status(200).json({ ok: true });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, adminPassword, groupId, name, newPassword } = req.body;

  // 管理者認証
  if (adminPassword !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: '管理者パスワードが違います' });
  }

  // パスワードリセット
  if (action === 'reset') {
    if (!groupId || !name) return res.status(400).json({ error: 'missing fields' });
    // リセットフラグを立てる（各自のスマホが次回ログイン時に検知して初回設定に戻す）
    await redisSet(`apply-reset:${groupId}:${name}`, { resetAt: new Date().toISOString() });
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'unknown action' });
}
