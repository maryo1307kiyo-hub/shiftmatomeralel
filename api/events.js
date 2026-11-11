// api/events.js - 横浜アリーナのイベント情報取得

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { year, month, debug } = req.query;
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

    // 0件のときは原因が分かるよう自動で診断情報を付ける（debug=1でも強制表示）
    if (events.length === 0 || debug === '1') {
      const text = html
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ');
      return res.status(200).json({
        events,
        diag: {
          url,
          status: response.status,
          htmlLength: html.length,
          hasDate: /\d{4}\.\d{2}\.\d{2}/.test(text),
          dateSamples: (text.match(/\d{4}\.\d{2}\.\d{2}[^0-9]{0,40}/g) || []).slice(0, 8),
          hasDetailLink: /\/event\/detail\//.test(html),
          textHead: text.slice(0, 900),
        },
      });
    }

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
      name,
      url: findEventUrl(html, `${year}.${mo}.${day}`, name),
    });
  }

  return events;
}

// 元HTMLから、その日付の近くにあるイベント詳細ページのリンクを探す
function findEventUrl(html, dateStr, name) {
  const BASE = 'https://www.yokohama-arena.co.jp';
  try {
    // 1) 日付文字列の前後を見て /event/detail/ へのリンクを拾う
    let idx = html.indexOf(dateStr);
    while (idx !== -1) {
      const win = html.slice(Math.max(0, idx - 1500), idx + 2500);
      const m = win.match(/href=["']([^"']*\/event\/detail\/[^"']+)["']/);
      if (m) return m[1].startsWith('http') ? m[1] : BASE + (m[1].startsWith('/') ? m[1] : '/' + m[1]);
      idx = html.indexOf(dateStr, idx + 1);
    }

    // 2) イベント名の近くを見る（日付とリンクが離れている構造の保険）
    const nameIdx = html.indexOf(name.slice(0, 12));
    if (nameIdx !== -1) {
      const win = html.slice(Math.max(0, nameIdx - 2000), nameIdx + 2000);
      const m = win.match(/href=["']([^"']*\/event\/detail\/[^"']+)["']/);
      if (m) return m[1].startsWith('http') ? m[1] : BASE + (m[1].startsWith('/') ? m[1] : '/' + m[1]);
    }
  } catch(e) {}
  return null;
}
