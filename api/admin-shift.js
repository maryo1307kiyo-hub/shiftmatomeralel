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

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, adminPassword, groupId, name, newPassword } = req.body;

  // 管理者認証
  if (adminPassword !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: '管理者パスワードが違います' });
  }

  // パスワードリセット（削除）
  if (action === 'reset') {
    if (!groupId || !name) return res.status(400).json({ error: 'missing fields' });
    await redisDel(`shift-pw:${groupId}:${name}`);
    return res.status(200).json({ ok: true });
  }

  // パスワード強制変更
  if (action === 'set') {
    if (!groupId || !name || !newPassword) return res.status(400).json({ error: 'missing fields' });
    if (newPassword.length < 4) return res.status(400).json({ error: '4文字以上で設定してください' });
    await redisSet(`shift-pw:${groupId}:${name}`, { password: newPassword });
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'unknown action' });
}
