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
    // 確定シフト取得
    const confirmedRes = await fetch(url, { headers });
    if (!confirmedRes.ok) return res.status(confirmedRes.status).json({ error: `HTTP ${confirmedRes.status}` });
    const confirmedHtml = await confirmedRes.text();
    const { shifts: confirmedShifts, pending: pendingFromConfirmed, rejected: confirmedRejected, year, month } = parseConfirmedHTML(confirmedHtml);

    // 申請シフト取得用の s= パラメータ：
    // 1) URLから抽出（?s=xxx 形式）
    // 2) 無ければ確定ページHTML内のリンク（/shift/bulk_edit?s=xxx）から自動抽出（パス型URL対応）
    const sParam = url.match(/[?&]s=([^&]+)/)?.[1]
                || confirmedHtml.match(/bulk_edit\?s=([a-zA-Z0-9]+)/)?.[1];

    // ホストは登録URLに合わせる（旧: m.s1 / 新: m-s1 両対応）
    const origin = url.match(/^https?:\/\/[^\/]+/)?.[0] || 'https://m-s1.ciftr.jp';

    let pendingFromBulk = [];
    if (sParam) {
      const bulkUrl = `${origin}/shift/bulk_edit?s=${sParam}`;
      try {
        const pendingRes = await fetch(bulkUrl, { headers });
        if (pendingRes.ok) {
          const pendingHtml = await pendingRes.text();
          pendingFromBulk = parsePendingHTML(pendingHtml, year, month);
        }
      } catch(e) { /* 申請シフト取得失敗は無視 */ }
    }

    // 確定シフトの日付セット
    const confirmedDates = new Set(confirmedShifts.map(s => s.date));

    // 申請シフトを統合：確定ページの赤文字（希望）＋ bulk_editの入力値
    // 同一日付は確定ページ由来を優先（時刻表示が正規化済みのため）
    const pendingMap = new Map();
    for (const s of pendingFromBulk) {
      if (!s.rejected) pendingMap.set(s.date, s);
    }
    for (const s of pendingFromConfirmed) {
      pendingMap.set(s.date, s);
    }
    const pendingOnly = [...pendingMap.values()].filter(s => !confirmedDates.has(s.date));

    // 不採用の統合：確定ページの「---」＋ 申請ページの「--:-- --:--」
    const bulkRejected = pendingFromBulk.filter(s => s.rejected && !confirmedDates.has(s.date));
    const rejectedDates = new Set();
    const rejectedOnly = [];
    for (const r of [...confirmedRejected, ...bulkRejected]) {
      if (!confirmedDates.has(r.date) && !rejectedDates.has(r.date) && !pendingMap.has(r.date)) {
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
  const pending = [];
  const rejected = [];

  // 赤文字（希望シフト・未確定）にマーカー◆を付けてからタグを剥がす
  // ciftrは確定ページ上で「黒＝確定」「赤＝希望中」を色で区別している
  const text = html
    .replace(/<font\s+color=["']?#ff0000["']?\s*>/gi, '◆')
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

  for (const rawLine of lines) {
    // 曜日ラベルの赤（日曜・祝日の「(日)」等）は無視し、時刻部分の赤だけを希望判定に使う
    const dowStripped = rawLine.replace(/([（(])◆/g, '$1');
    const hasRed = dowStripped.includes('◆');
    const line = rawLine.replace(/◆/g, ''); // マーカー除去後のテキストで解析

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
        const entry = {
          date: `${year}-${String(month).padStart(2,'0')}-${String(parseInt(dayMatch[1])).padStart(2,'0')}`,
          start: parts[0].trim(),
          end: parts[1].trim()
        };
        // 赤文字の時間＝希望（未確定）、黒＝確定
        if (hasRed) pending.push(entry);
        else shifts.push(entry);
      }
    }
  }
  return { shifts, pending, rejected, year, month };
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
