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

    // sパラメータを取得（クエリ型・パス型両対応）
    const sParam = url.match(/[?&]s=([^&]+)/)?.[1]
                || url.match(/\/login\/\d+\/(\d+\/\d+)/)?.[0];
    if (!sParam) return res.status(400).json({ error: '無効なURL' });

    // 常にbulk_editエンドポイントに送信
    const baseHost = url.includes('m.s1.ciftr.jp') ? 'http://m.s1.ciftr.jp' : 'https://m-s1.ciftr.jp';
    const bulkEditUrl = `${baseHost}/shift/bulk_edit?s=${sParam}`;

    // shiftsは { "20260718": "1030+1900", "20260720": "" } 形式
    // 日付によってp=1（16〜末日）とp=2（1〜15日）に分けて送信
    const page1Shifts = {};
    const page2Shifts = {};
    for (const [date, time] of Object.entries(shifts)) {
      if (!time || !time.trim()) continue;
      const day = parseInt(date.slice(6, 8));
      if (day >= 16) {
        page1Shifts[date] = time.trim();
      } else {
        page2Shifts[date] = time.trim();
      }
    }

    if (Object.keys(page1Shifts).length === 0 && Object.keys(page2Shifts).length === 0) {
      return res.status(400).json({ error: '申請する日程がありません' });
    }

    const sendPage = async (pageNum, pageShifts) => {
      if (Object.keys(pageShifts).length === 0) return true;
      const fd = new URLSearchParams();
      fd.append('s', sParam);
      for (const [date, time] of Object.entries(pageShifts)) {
        fd.append(`sr[${date}]`, time);
      }
      console.log(`POST p=${pageNum}:`, fd.toString());
      const r = await fetch(`${baseHost}/shift/bulk_edit?p=${pageNum}&s=${sParam}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
          'Origin': baseHost,
          'Referer': `${baseHost}/shift/bulk_edit?s=${sParam}`,
        },
        body: fd.toString()
      });
      const responseText = await ciftrRes.text();
      console.log(`p=${pageNum} status:`, ciftrRes.status);
      console.log(`p=${pageNum} response:`, responseText.slice(0, 200));
      return ciftrRes.ok;
    };

    try {
      const r1 = await sendPage(1, page1Shifts);
      const r2 = await sendPage(2, page2Shifts);
      if (!r1 || !r2) {
        return res.status(500).json({ error: 'ciftrへの送信に失敗しました' });
      }
      return res.status(200).json({ ok: true });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
