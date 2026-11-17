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

  async function redisDel(key) {
    await fetch(`${UPSTASH_URL}/del/${encodeURIComponent(key)}`, {
      method: 'POST', headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
  }

  // シフターリンク → 「どのグループの誰か」の対応表（リンク＋PINログイン用。api/auth.js が読む）
  // リンクの s= の値（無い旧型はパス）を鍵にする。ホスト名の違い（m.s1 / m-s1）は無視
  function linkId(url) {
    const s = String(url || '').match(/[?&]s=([A-Za-z0-9]+)/);
    if (s) return 's:' + s[1];
    const m = String(url || '').match(/^https?:\/\/[^\/]+(\/[^?#]*)/);
    return m ? 'p:' + m[1].replace(/\/+$/, '').toLowerCase() : null;
  }
  const idxKey = (url) => { const id = linkId(url); return id ? `url-index:${id}` : null; };
  async function idxSet(gid, m) { const k = idxKey(m.url); if (k) await redisSet(k, { groupId: gid, name: m.name }); }
  async function idxDel(url) { const k = idxKey(url); if (k) await redisDel(k); }

  const { groupId, action } = req.query;
  if (!groupId) return res.status(400).json({ error: 'groupId required' });

  const key = `group:${groupId}`;

  if (req.method === 'GET') {
    const members = await redisGet(key);
    // 既存メンバーの対応表を1回だけ作る（この機能が入る前に登録された人の分）
    try {
      if (members && members.length && !(await redisGet(`url-index-built:${groupId}`))) {
        const cmds = members.map(m => [idxKey(m.url), m]).filter(x => x[0])
          .map(([k, m]) => ['SET', k, JSON.stringify({ groupId, name: m.name })]);
        cmds.push(['SET', `url-index-built:${groupId}`, '1']);
        await fetch(`${UPSTASH_URL}/pipeline`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(cmds)
        });
      }
    } catch (e) {}
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
      if (members.some(m => m.name === name)) return res.status(409).json({ error: 'その名前は既に使われています' });
      members.push({ name, url });
      await redisSet(key, members);
      try { await idxSet(groupId, { name, url }); } catch (e) {}
      return res.status(200).json({ members });
    }

    if (action === 'remove') {
      members = members.filter(m => m.url !== body.url);
      await redisSet(key, members);
      try { await idxDel(body.url); } catch (e) {}
      return res.status(200).json({ members });
    }

    if (action === 'rename') {
      const { url, oldName, newName } = body;
      if (!url || !newName) return res.status(400).json({ error: 'url and newName required' });
      const before = members.find(m => m.url === url);
      if (before && before.name !== newName && members.some(m => m.name === newName)) {
        return res.status(409).json({ error: 'その名前は既に使われています' });
      }
      members = members.map(m => m.url === url ? { ...m, name: newName } : m);
      await redisSet(key, members);
      // 個人アカウント（api/auth.js）の名前も追従させる。失敗しても改名自体は成立させる
      try { if (before) await idxSet(groupId, { name: newName, url }); } catch (e) {}
      try {
        if (before && before.name !== newName) {
          const { createHash } = await import('node:crypto');
          const h = (n) => createHash('sha1').update(String(n)).digest('hex').slice(0, 20);
          const oldKey = `account-name:${groupId}:${h(before.name)}`;
          const accId = await redisGet(oldKey);
          if (accId) {
            const acc = await redisGet(`account:${groupId}:${accId}`);
            if (acc) {
              acc.name = newName;
              await redisSet(`account:${groupId}:${accId}`, acc);
              await redisSet(`account-name:${groupId}:${h(newName)}`, accId);
              await fetch(`${UPSTASH_URL}/del/${encodeURIComponent(oldKey)}`, {
                method: 'POST', headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
              });
            }
          }
        }
      } catch (e) {}
      return res.status(200).json({ members });
    }

    if (action === 'updateUrl') {
      const { oldUrl, newUrl } = body;
      if (!oldUrl || !newUrl) return res.status(400).json({ error: 'oldUrl and newUrl required' });
      if (!newUrl.includes('ciftr.jp')) return res.status(403).json({ error: 'ciftr.jp only' });
      // 新URLが別メンバーで既に使われていないかチェック
      if (members.some(m => m.url === newUrl && m.url !== oldUrl)) {
        return res.status(409).json({ error: 'already exists' });
      }
      const target = members.find(m => m.url === oldUrl);
      if (!target) return res.status(404).json({ error: 'member not found' });
      members = members.map(m => m.url === oldUrl ? { ...m, url: newUrl } : m);
      await redisSet(key, members);
      try { await idxDel(oldUrl); await idxSet(groupId, { name: target.name, url: newUrl }); } catch (e) {}
      return res.status(200).json({ members, oldUrl, newUrl, name: target.name });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
