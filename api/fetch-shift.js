// api/fetch-shift.js
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { url, debug } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });
  if (!url.includes('ciftr.jp')) return res.status(403).json({ error: 'ciftr.jp only' });

  const headers = {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'ja,en-US;q=0.9',
  };

  try {
    // 確定シフト取得（赤時刻・黒時刻の区別なく全て確定として扱う）
    const confirmedRes = await fetch(url, { headers });
    if (!confirmedRes.ok) return res.status(confirmedRes.status).json({ error: `HTTP ${confirmedRes.status}` });
    const confirmedHtml = await confirmedRes.text();
    const { shifts: confirmedShifts, rejected: confirmedRejected, year, month } = parseConfirmedHTML(confirmedHtml);

    // 申請シフト（申請中）の唯一の情報源は bulk_edit ページ
    // s= パラメータ：
    // 1) URLから抽出（?s=xxx 形式）
    // 2) 無ければ確定ページHTML内のリンク（/shift/bulk_edit?s=xxx）から自動抽出（パス型URL対応）
    const sParam = url.match(/[?&]s=([^&]+)/)?.[1]
                || confirmedHtml.match(/bulk_edit\?s=([a-zA-Z0-9]+)/)?.[1];

    // ホストは登録URLに合わせる（旧: m.s1 / 新: m-s1 両対応）
    const origin = url.match(/^https?:\/\/[^\/]+/)?.[0] || 'https://m-s1.ciftr.jp';

    let pendingShifts = [];
    if (sParam) {
      const bulkUrl = `${origin}/shift/bulk_edit?s=${sParam}`;
      try {
        const pendingRes = await fetch(bulkUrl, { headers });
        if (pendingRes.ok) {
          const pendingHtml = await pendingRes.text();
          pendingShifts = parsePendingHTML(pendingHtml, year, month);
        }
      } catch(e) { /* 申請シフト取得失敗は無視 */ }
    }

    // 確定シフトの日付セット
    const confirmedDates = new Set(confirmedShifts.map(s => s.date));

    // 申請シフトから確定済みを除外し、不採用を分離
    const pendingOnly = pendingShifts.filter(s => !confirmedDates.has(s.date) && !s.rejected);
    const pendingRejected = pendingShifts.filter(s => s.rejected && !confirmedDates.has(s.date));

    // 確定ページの「---」検出 と 申請ページの不採用検出 を統合（重複日付は除去）
    const rejectedDates = new Set();
    const rejectedOnly = [];
    for (const r of [...confirmedRejected, ...pendingRejected]) {
      if (!confirmedDates.has(r.date) && !rejectedDates.has(r.date)) {
        rejectedDates.add(r.date);
        rejectedOnly.push({ date: r.date, rejected: true });
      }
    }

    const response = {
      shifts: confirmedShifts,
      pendingShifts: pendingOnly,
      rejectedShifts: rejectedOnly,
      year, month
    };

    // デバッグモード：Vercelが実際に受け取ったHTMLの先頭を返す
    if (debug === '1') {
      response.debugStatus = confirmedRes.status;
      response.debugHtmlHead = confirmedHtml.slice(0, 1500);
      response.debugHtmlLength = confirmedHtml.length;
      response.debugSParam = sParam || null;
    }

    return res.status(200).json(response);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

function parseConfirmedHTML(html) {
  const shifts = [];
  const rejected = [];
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
    const ymMatch = line.match(/(\d{4})年\s*(\d{1,2})月/);
    if (ymMatch) { year = parseInt(ymMatch[1]); month = parseInt(ymMatch[2]); continue; }
    const mOnly = line.match(/^(\d{1,2})月$/);
    if (mOnly) {
      month = parseInt(mOnly[1]);
      if (month === 1 && new Date().getMonth() === 11) year++;
      continue;
    }

    // "7日(土) ---" パターン（申請していたシフトが取り消し・削除された）
    const rejectedMatch = line.match(/^(\d{1,2})日[（(][月火水木金土日][）)][\s　]*-{2,}\s*$/);
    if (rejectedMatch && month !== null) {
      rejected.push({
        date: `${year}-${String(month).padStart(2,'0')}-${String(parseInt(rejectedMatch[1])).padStart(2,'0')}`,
        rejected: true
      });
      continue;
    }

    const dayMatch = line.match(/^(\d{1,2})日[（(][月火水木金土日][）)][\s　]*([\d:]+[-–ー][\d:]+)?/);
    if (dayMatch && month !== null && dayMatch[2]) {
      const parts = dayMatch[2].trim().split(/[-–ー]/);
      if (parts.length >= 2) {
        shifts.push({
          date: `${year}-${String(month).padStart(2,'0')}-${String(parseInt(dayMatch[1])).padStart(2,'0')}`,
          start: parts[0].trim(),
          end: parts[1].trim()
        });
      }
    }
  }
  return { shifts, rejected, year, month };
}

function parsePendingHTML(html, baseYear, baseMonth) {
  const shifts = [];
  let year = baseYear || new Date().getFullYear();
  let month = baseMonth || null;

  // inputタグのvalue属性を日付行と一緒に抽出
  const text = html
    .replace(/<input[^>]*value=["'](\d{3,4}\s+\d{3,4})["'][^>]*>/gi, (m, val) => ` ${val}`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(div|p|li|tr|td|th)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    const ymMatch = line.match(/(\d{4})年\s*(\d{1,2})月/);
    if (ymMatch) { year = parseInt(ymMatch[1]); month = parseInt(ymMatch[2]); continue; }
    const mOnly = line.match(/^(\d{1,2})月$/);
    if (mOnly) {
      month = parseInt(mOnly[1]);
      if (month === 1 && new Date().getMonth() === 11) year++;
      continue;
    }

    // "25日(木) 1530 1900" パターン（申請中の入力値）
    const dayMatch = line.match(/^(\d{1,2})日[（(][月火水木金土日][）)][\s　]*(\d{3,4})\s+(\d{3,4})/);
    if (dayMatch && month !== null) {
      shifts.push({
        date: `${year}-${String(month).padStart(2,'0')}-${String(parseInt(dayMatch[1])).padStart(2,'0')}`,
        start: formatTime(dayMatch[2]),
        end: formatTime(dayMatch[3])
      });
      continue;
    }

    // "25日(木) --:-- --:--" パターン（不採用・見送り）
    const rejectedMatch = line.match(/^(\d{1,2})日[（(][月火水木金土日][）)][\s　]*-+:-+\s+-+:-+/);
    if (rejectedMatch && month !== null) {
      shifts.push({
        date: `${year}-${String(month).padStart(2,'0')}-${String(parseInt(rejectedMatch[1])).padStart(2,'0')}`,
        rejected: true
      });
    }
  }
  return shifts;
}

function formatTime(t) {
  const s = t.padStart(4, '0');
  return `${parseInt(s.slice(0,2))}:${s.slice(2)}`;
}
