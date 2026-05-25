// api/fetch-shift.js
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });
  if (!url.includes('ciftr.jp')) return res.status(403).json({ error: 'ciftr.jp only' });

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ja,en-US;q=0.9',
      }
    });
    if (!response.ok) return res.status(response.status).json({ error: `HTTP ${response.status}` });

    const html = await response.text();
    const shifts = parseShiftHTML(html);
    return res.status(200).json(shifts);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

function parseShiftHTML(html) {
  const shifts = [];

  // タグを除去してテキストだけ残す
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(div|p|li|tr|td|th)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  let year = new Date().getFullYear();
  let month = null;

  for (const line of lines) {
    // 年月パターン
    const ymMatch = line.match(/(\d{4})年\s*(\d{1,2})月/);
    if (ymMatch) { year = parseInt(ymMatch[1]); month = parseInt(ymMatch[2]); continue; }

    // 月だけのパターン（例: "5月" "6月"）
    const mOnly = line.match(/^(\d{1,2})月$/);
    if (mOnly) {
      month = parseInt(mOnly[1]);
      if (month === 1 && new Date().getMonth() === 11) year++;
      continue;
    }

    // 日付行パターン: "16日(土) 11:00-19:00" or "16日(土)"
    // 全角・半角括弧両対応、スペース・全角スペース対応
    const dayMatch = line.match(/^(\d{1,2})日[（(][月火水木金土日][）)][\s　]*([\d:]+[-–ー][\d:]+)?/);
    if (dayMatch && month !== null && dayMatch[2]) {
      const timeStr = dayMatch[2].trim();
      const parts = timeStr.split(/[-–ー]/);
      if (parts.length >= 2) {
        shifts.push({
          date: `${year}-${String(month).padStart(2,'0')}-${String(parseInt(dayMatch[1])).padStart(2,'0')}`,
          start: parts[0].trim(),
          end: parts[1].trim()
        });
      }
    }
  }
  return { shifts, year, month };
}
