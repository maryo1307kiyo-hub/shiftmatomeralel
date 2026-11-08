// api/survey.js - イベント現場アンケート（混雑・フード余り・アルコール有無）

const UPSTASH_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function rGet(key) {
  const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
  });
  const d = await r.json();
  return d.result ? JSON.parse(d.result) : null;
}

async function rSet(key, value) {
  await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value)
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;

  try {
    // --- 回答を保存 ---
    if (req.method === 'POST' && action === 'submit') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const { groupId, date, uid, name, worked, crowd, food, alcohol, eventName, note } = body;
      if (!groupId || !date) return res.status(400).json({ error: 'groupId and date required' });

      // 日付ごとに回答を蓄積（同じ端末が再回答したら上書き）
      const key = `survey:${groupId}:${date}`;
      const list = (await rGet(key)) || [];
      const entry = {
        uid: uid || null,
        name: name || null,          // シフト申請を設定済みの人だけ名前が入る
        worked: worked || null,      // 入ってた / 入ってない
        crowd: crowd ?? null,        // 1〜5
        food: food ?? null,          // 1〜5
        alcohol: alcohol || null,
        eventName: eventName || null,
        note: note || null,
        submittedAt: new Date().toISOString(),
      };
      const idx = uid
        ? list.findIndex(x => x && x.uid === uid)
        : list.findIndex(x => x && name && x.name === name);
      if (idx >= 0) list[idx] = entry; else list.push(entry);
      await rSet(key, list);

      // 回答済み日付の索引を更新（一覧取得用）
      const idxKey = `survey-index:${groupId}`;
      const dates = (await rGet(idxKey)) || [];
      if (!dates.includes(date)) {
        dates.push(date);
        dates.sort();
        await rSet(idxKey, dates);
      }

      return res.status(200).json({ ok: true, count: list.length });
    }

    // --- ある日付の回答状況（自分が回答済みかの確認用） ---
    if (action === 'status') {
      const { groupId, date, uid } = req.query;
      if (!groupId || !date) return res.status(400).json({ error: 'groupId and date required' });
      const list = (await rGet(`survey:${groupId}:${date}`)) || [];
      return res.status(200).json({
        answered: uid ? list.some(x => x && x.uid === uid) : false,
        count: list.length,
      });
    }

    // --- 蓄積データの取得（今後の分析用） ---
    if (action === 'list') {
      const { groupId, date } = req.query;
      if (!groupId) return res.status(400).json({ error: 'groupId required' });

      if (date) {
        const list = (await rGet(`survey:${groupId}:${date}`)) || [];
        return res.status(200).json({ date, responses: list });
      }

      const dates = (await rGet(`survey-index:${groupId}`)) || [];
      const all = {};
      for (const d of dates) {
        all[d] = (await rGet(`survey:${groupId}:${d}`)) || [];
      }
      return res.status(200).json({ dates, data: all });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
