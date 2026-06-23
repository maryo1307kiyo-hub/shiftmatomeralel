// api/submit-shift.js - シフト申請をciftrに送信

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

  // パスワード設定
  if (req.method === 'POST' && req.query.action === 'set-password') {
    const { groupId, name, password } = req.body;
    if (!groupId || !name || !password) return res.status(400).json({ error: 'missing fields' });
    if (password.length < 4) return res.status(400).json({ error: 'パスワードは4文字以上にしてください' });
    const existing = await redisGet(`shift-pw:${groupId}:${name}`);
    if (existing) return res.status(400).json({ error: 'すでにパスワードが設定されています' });
    await redisSet(`shift-pw:${groupId}:${name}`, { password });
    return res.status(200).json({ ok: true });
  }

  // パスワード確認
  if (req.method === 'POST' && req.query.action === 'verify-password') {
    const { groupId, name, password } = req.body;
    if (!groupId || !name || !password) return res.status(400).json({ error: 'missing fields' });
    const stored = await redisGet(`shift-pw:${groupId}:${name}`);
    if (!stored) return res.status(404).json({ error: 'not-set' });
    if (stored.password !== password) return res.status(401).json({ error: 'パスワードが違います' });
    return res.status(200).json({ ok: true });
  }

  // シフト申請送信
  if (req.method === 'POST' && req.query.action === 'submit') {
    const { groupId, name, password, url, shifts } = req.body;
    if (!groupId || !name || !password || !url || !shifts) {
      return res.status(400).json({ error: 'missing fields' });
    }

    // パスワード確認
    const stored = await redisGet(`shift-pw:${groupId}:${name}`);
    if (!stored || stored.password !== password) {
      return res.status(401).json({ error: 'パスワードが違います' });
    }

    const sParam = url.match(/[?&]s=([^&]+)/)?.[1];
    if (!sParam) return res.status(400).json({ error: '無効なURL' });

    const baseHost = 'http://m.s1.ciftr.jp';

    // 日付をp=1（16〜末日）とp=2（1〜15日）に分ける
    const page1 = {}, page2 = {};
    for (const [date, time] of Object.entries(shifts)) {
      if (!time || !time.trim()) continue;
      const day = parseInt(date.slice(6, 8));
      if (day >= 16) page1[date] = time.trim();
      else page2[date] = time.trim();
    }

    if (Object.keys(page1).length === 0 && Object.keys(page2).length === 0) {
      return res.status(400).json({ error: '申請する日程がありません' });
    }

    const sendPage = async (pageNum, pageShifts) => {
      if (Object.keys(pageShifts).length === 0) return { ok: true };

      // Step1: GETでページを開いてCookieを取得
      const getUrl = `${baseHost}/shift/bulk_edit?p=${pageNum}&s=${sParam}`;
      const getRes = await fetch(getUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ja-JP,ja;q=0.9',
        },
        redirect: 'follow'
      });

      // CookieをSet-Cookieヘッダーから取得
      const setCookie = getRes.headers.get('set-cookie') || '';
      const cookie = setCookie.split(';')[0];
      console.log(`p=${pageNum} GET status:`, getRes.status, 'cookie:', cookie);

      // Step2: 取得したCookieを付けてPOST
      const fd = new URLSearchParams();
      fd.append('s', sParam);
      for (const [date, time] of Object.entries(pageShifts)) {
        fd.append(`sr[${date}]`, time);
      }

      const postHeaders = {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja-JP,ja;q=0.9',
        'Origin': baseHost,
        'Referer': getUrl,
      };
      if (cookie) postHeaders['Cookie'] = cookie;

      const postRes = await fetch(`${baseHost}/shift/bulk_edit?p=${pageNum}&s=${sParam}`, {
        method: 'POST',
        headers: postHeaders,
        body: fd.toString(),
        redirect: 'follow'
      });

      const responseText = await postRes.text();
      console.log(`p=${pageNum} POST status:`, postRes.status);
      console.log(`p=${pageNum} response:`, responseText.slice(0, 300));

      return { ok: postRes.ok, status: postRes.status, body: responseText.slice(0, 300) };
    };

    try {
      const r1 = await sendPage(1, page1);
      const r2 = await sendPage(2, page2);
      return res.status(200).json({ ok: true, r1, r2 });
    } catch(e) {
      console.error('submit error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
