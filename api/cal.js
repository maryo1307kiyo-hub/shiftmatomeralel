// api/cal.js - iCal購読URL（メンバーごとに自動更新）

export default async function handler(req, res) {
  const { g: groupId, name } = req.query;

  if (!groupId || !name) {
    return res.status(400).send('groupId and name required');
  }

  const UPSTASH_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  async function redisGet(key) {
    const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : null;
  }

  // メンバーリスト取得
  const members = await redisGet(`group:${groupId}`);
  if (!members) return res.status(404).send('Group not found');

  const member = members.find(m => m.name === name);
  if (!member) return res.status(404).send('Member not found');

  // シフトキャッシュ取得
  const cached = await redisGet(`shifts:${groupId}`);
  let shifts = [], pendingShifts = [];

  if (cached && cached.results) {
    const memberData = cached.results.find(r => r.name === name);
    if (memberData) {
      shifts = memberData.shifts || [];
      pendingShifts = memberData.pendingShifts || [];
    }
  }

  // キャッシュがなければciftrから直接取得
  if (!shifts.length && !pendingShifts.length) {
    try {
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const apiUrl = `${proto}://${host}/api/fetch-shift?url=${encodeURIComponent(member.url)}`;
      const r = await fetch(apiUrl);
      if (r.ok) {
        const d = await r.json();
        shifts = d.shifts || [];
        pendingShifts = d.pendingShifts || [];
      }
    } catch(e) {}
  }

  // iCal生成
  const now = new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//しふとまとめれ～る//JP',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${name} のシフト`,
    'X-WR-TIMEZONE:Asia/Tokyo',
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
    'X-PUBLISHED-TTL:PT6H',
  ];

  const allShifts = [
    ...shifts.map(s => ({...s, pending: false})),
    ...pendingShifts.map(s => ({...s, pending: true}))
  ];

  for (const s of allShifts) {
    const [y, mo, d] = s.date.split('-');
    const startH = s.start.replace(':', '');
    const endH = s.end.replace(':', '');
    const dtStart = `${y}${mo}${d}T${startH}00`;
    const dtEnd = `${y}${mo}${d}T${endH}00`;
    const uid = `${s.date}-${name}-${s.start}@shiftmatomerel`;
    const summary = s.pending ? `【申請】${name} シフト` : `${name} シフト`;

    lines.push(
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${now}Z`,
      `DTSTART;TZID=Asia/Tokyo:${dtStart}`,
      `DTEND;TZID=Asia/Tokyo:${dtEnd}`,
      `SUMMARY:${summary}`,
      `DESCRIPTION:グループID: ${groupId}\\nしふとまとめれ～る`,
      'END:VEVENT'
    );
  }

  lines.push('END:VCALENDAR');

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `inline; filename="${name}_shift.ics"`);
  res.setHeader('Cache-Control', 'no-cache');
  return res.status(200).send(lines.join('\r\n'));
}
