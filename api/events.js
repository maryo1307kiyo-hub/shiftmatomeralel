// api/events.js - 横浜アリーナのイベント情報取得

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { year, month } = req.query;
  if (!year || !month) return res.status(400).json({ error: 'year and month required' });

  const url = `https://www.yokohama-arena.co.jp/event/${year}-${String(month).padStart(2,'0')}`;

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ja,en-US;q=0.9',
      }
    });

    if (!response.ok) return res.status(response.status).json({ error: `HTTP ${response.status}` });

    const html = await response.text();
    const events = parseEvents(html, year, month);
    return res.status(200).json({ events });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}

function parseEvents(html, year, month) {
  const events = [];
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  // 日付パターン: "2026.06.02 コンサート イベント名"
  const pattern = new RegExp(`${year}\\.${String(month).padStart(2,'0')}\\.(\\d{2})\\s+(コンサート|スポーツ|その他|展示|格闘技|プロレス|バスケットボール|バレーボール)\\s+([^2]+?)(?=\\s*${year}|$)`, 'g');

  let match;
  while ((match = pattern.exec(text)) !== null) {
    const day = match[1];
    const type = match[2];
    const name = match[3].trim().slice(0, 40);
    const date = `${year}-${String(month).padStart(2,'0')}-${day}`;

    events.push({ date, type, name });
  }

  return events;
}
