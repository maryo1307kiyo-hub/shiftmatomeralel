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
    const events = parseEvents(html);
    return res.status(200).json({ events });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}

function parseEvents(html) {
  const events = [];
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

  // "2026.07.04 コンサート イベント名 開場：..." 形式
  const dateTypePattern = /(\d{4})\.(\d{2})\.(\d{2})\s+(コンサート|スポーツ|その他|展示|格闘技|プロレス|バスケットボール|バレーボール|ショー)\s+/g;

  let match;
  while ((match = dateTypePattern.exec(text)) !== null) {
    const year = match[1];
    const mo = match[2];
    const day = match[3];
    const type = match[4];

    const afterMatch = text.slice(match.index + match[0].length);
    // イベント名：次の「開場」「開演」「日付」まで（最大60文字）
    const nameMatch = afterMatch.match(/^(.{2,60}?)(?:\s+(?:開場|開演|終演|\d{4}\.))/);
    if (!nameMatch) continue;

    const name = nameMatch[1].trim().slice(0, 40);
    if (!name || name.length < 2) continue;

    events.push({
      date: `${year}-${mo}-${day}`,
      type,
      name
    });
  }

  return events;
}
