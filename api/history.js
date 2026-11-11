// api/history.js - シフト履歴の閲覧（誰がいつ入ったかの記録）
// 記録そのものは get-shifts.js が取得のたびに追記している

const UPSTASH_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function rGet(key) {
  const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
  });
  const d = await r.json();
  return d.result ? JSON.parse(d.result) : null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { groupId, month, name, format } = req.query;
  if (!groupId) return res.status(400).json({ error: 'groupId required' });

  try {
    const months = (await rGet(`history-index:${groupId}`)) || [];

    // --- 年間ランキング ---
    if (req.query.action === 'ranking') {
      const year = String(req.query.year || new Date(Date.now() + 9*3600*1000).getFullYear());
      const target = months.filter(m => m.startsWith(year + '-'));

      const people = {};          // 名前 → { count, minutes, dates[] }
      const byDate = {};          // 日付 → 出勤人数
      const pairs = {};           // "A|B" → 一緒に入った回数

      for (const m of target) {
        const days = (await rGet(`history:${groupId}:${m}`)) || {};
        for (const [date, crew] of Object.entries(days)) {
          const names = Object.keys(crew);
          if (!names.length) continue;
          byDate[date] = names.length;

          for (const n of names) {
            people[n] = people[n] || { name: n, count: 0, minutes: 0, dates: [] };
            people[n].count++;
            people[n].minutes += durationMin(crew[n]);
            people[n].dates.push(date);
          }
          // 相棒カウント
          const sorted = [...names].sort();
          for (let i = 0; i < sorted.length; i++) {
            for (let j = i + 1; j < sorted.length; j++) {
              const k = sorted[i] + '|' + sorted[j];
              pairs[k] = (pairs[k] || 0) + 1;
            }
          }
        }
      }

      const list = Object.values(people).map(p => ({
        name: p.name,
        count: p.count,
        hours: Math.round(p.minutes / 6) / 10,
        firstDate: p.dates.sort()[0] || null,
        lastDate: p.dates[p.dates.length - 1] || null,
      }));

      const byCount = [...list].sort((a,b) => b.count - a.count || b.hours - a.hours);
      const byHours = [...list].sort((a,b) => b.hours - a.hours || b.count - a.count);

      const busiest = Object.entries(byDate)
        .sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 10)
        .map(([date, n]) => ({ date, people: n }));

      // 人が少なかった日（少人数で回した日）
      const quietest = Object.entries(byDate)
        .sort((a,b) => a[1] - b[1] || a[0].localeCompare(b[0]))
        .slice(0, 10)
        .map(([date, n]) => ({ date, people: n }));

      const bestPairs = Object.entries(pairs)
        .sort((a,b) => b[1] - a[1])
        .slice(0, 10)
        .map(([k, n]) => ({ pair: k.split('|'), count: n }));

      return res.status(200).json({
        year,
        months: target,
        recordedDays: Object.keys(byDate).length,
        totalShifts: list.reduce((s,p) => s + p.count, 0),
        totalHours: Math.round(list.reduce((s,p) => s + p.hours, 0) * 10) / 10,
        byCount, byHours, busiest, quietest, bestPairs,
      });
    }

    // --- 特定の月だけ ---
    if (month) {
      const days = (await rGet(`history:${groupId}:${month}`)) || {};
      if (format === 'csv') return sendCsv(res, { [month]: days }, name);
      return res.status(200).json({ month, days: filterByName(days, name) });
    }

    // --- 全期間 ---
    const all = {};
    for (const m of months) {
      all[m] = (await rGet(`history:${groupId}:${m}`)) || {};
    }
    if (format === 'csv') return sendCsv(res, all, name);

    // 個人の集計（name指定時）
    if (name) {
      const dates = [];
      let totalMin = 0;
      for (const m of months) {
        for (const [date, people] of Object.entries(all[m] || {})) {
          if (people[name]) {
            dates.push({ date, time: people[name] });
            totalMin += durationMin(people[name]);
          }
        }
      }
      dates.sort((a, b) => a.date.localeCompare(b.date));
      return res.status(200).json({
        name, months, count: dates.length,
        totalHours: Math.round(totalMin / 6) / 10,
        dates,
      });
    }

    return res.status(200).json({ months, data: all });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

function filterByName(days, name) {
  if (!name) return days;
  const out = {};
  for (const [date, people] of Object.entries(days)) {
    if (people[name]) out[date] = { [name]: people[name] };
  }
  return out;
}

function durationMin(range) {
  const m = String(range).match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!m) return 0;
  let mins = (+m[3]) * 60 + (+m[4]) - ((+m[1]) * 60 + (+m[2]));
  if (mins < 0) mins += 24 * 60; // 日跨ぎ
  return mins;
}

function sendCsv(res, all, name) {
  const rows = ['日付,名前,開始,終了,時間'];
  const months = Object.keys(all).sort();
  for (const m of months) {
    const days = all[m] || {};
    for (const date of Object.keys(days).sort()) {
      for (const [person, range] of Object.entries(days[date])) {
        if (name && person !== name) continue;
        const parts = String(range).split('-');
        rows.push([date, person, parts[0] || '', parts[1] || '',
                   (Math.round(durationMin(range) / 6) / 10)].join(','));
      }
    }
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="shift-history.csv"');
  return res.status(200).send('﻿' + rows.join('\n'));
}

