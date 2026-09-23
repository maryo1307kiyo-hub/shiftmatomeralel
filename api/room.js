// api/room.js - フラッシュ会計 オンライン対戦（ルーム管理＋Pusher配信）
import crypto from 'crypto';

const UPSTASH_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const PUSHER_APP_ID  = process.env.PUSHER_APP_ID;
const PUSHER_KEY     = process.env.PUSHER_KEY;
const PUSHER_SECRET  = process.env.PUSHER_SECRET;
const PUSHER_CLUSTER = process.env.PUSHER_CLUSTER || 'ap3';

const MAX_PLAYERS = 10;
const ROOM_TTL = 60 * 60 * 3; // 3時間で自動消滅

// ===== 商品データ（index.html と同内容） =====
const ITEMS = {
  base: [
    {name:'ソフトドリンク', price:250, freq:5.5},
    {name:'アイスコーヒー', price:400, freq:0.7},
    {name:'レッドブル', price:500, freq:3.5},
    {name:'もちコロ', price:400, freq:6.0},
    {name:'ふるふるポテト', price:500, freq:7.0},
    {name:'粗挽きジャンボフランク', price:500, freq:6.8},
    {name:'アメリカンクリスピーポテト', price:500, freq:8.5},
    {name:'焼きおにぎり', price:500, freq:6.5},
    {name:'横濱からあげ醤油味', price:600, freq:8.7},
    {name:'大玉揚げたこ焼き', price:600, freq:8.3},
    {name:'おたふくソース焼きそば', price:700, freq:6.9},
    {name:'やわらかカツサンド', price:700, freq:5.0},
    {name:'究極のホットドッグ', price:900, freq:4.0},
    {name:'チュロス', price:700, freq:9.0, oncePerOrder:true},
  ],
  alcohol: [
    {name:'ハイボール', price:700, freq:6.5},
    {name:'氷結', price:700, freq:6.5},
    {name:'スミノフ', price:800, freq:6.5},
    {name:'生ビール', price:900, freq:6.5},
    {name:'レッドブルウォッカ シングル', price:900, freq:6.5},
    {name:'レッドブルウォッカ ダブル', price:1200, freq:6.5},
  ],
  extra: [
    {name:'豚まん', price:700, freq:7.4},
    {name:'ホットコーヒー', price:400, freq:4.2},
    {name:'カラーソーダ', price:500, freq:9.4},
    {name:'コラボドリンク（ノンアル）', price:500, freq:6.0},
    {name:'コラボドリンク（アルコール）', price:800, freq:6.0},
    {name:'カツカレー', price:1000, freq:3.0},
    {name:'今川焼き', price:250, freq:1.5},
  ],
};

const DRINKS = new Set([
  'ソフトドリンク','アイスコーヒー','レッドブル','ハイボール','氷結','スミノフ','生ビール',
  'レッドブルウォッカ シングル','レッドブルウォッカ ダブル','ホットコーヒー',
  'カラーソーダ','コラボドリンク（ノンアル）','コラボドリンク（アルコール）'
]);

// 難易度定義（1=イージー, 2=ノーマル, 3=エクストラ）
const DIFF = {
  1: { label:'イージー',   range:[3,6],  speed:2000, answerSec:12 },
  2: { label:'ノーマル',   range:[5,10], speed:1800, answerSec:7  },
  3: { label:'エクストラ', range:[8,15], speed:1500, answerSec:6  },
};

function buildPool(level) {
  let pool = [...ITEMS.base];
  if (level >= 2) pool = pool.concat(ITEMS.alcohol);
  if (level >= 3) pool = pool.concat(ITEMS.extra);
  return pool;
}

function weightedPick(pool, used) {
  const filtered = used ? pool.filter(p => !used.has(p.name)) : pool;
  const isDrink = Math.random() < 0.4;
  let cand = filtered.filter(p => DRINKS.has(p.name) === isDrink);
  if (!cand.length) cand = filtered;
  const total = cand.reduce((s,p) => s + p.freq, 0);
  let r = Math.random() * total;
  for (const it of cand) { r -= it.freq; if (r <= 0) return it; }
  return cand[cand.length-1];
}

function makeQuestion(level) {
  const d = DIFF[level] || DIFF[1];
  const [min,max] = d.range;
  const count = min + Math.floor(Math.random() * (max - min + 1));
  const pool = buildPool(level);
  const items = [];
  const used = new Set();
  for (let i = 0; i < count; i++) {
    const it = weightedPick(pool, used);
    if (it.oncePerOrder) used.add(it.name);
    items.push({ name: it.name, price: it.price });
  }
  return {
    level,
    items: items.map(i => i.name),
    total: items.reduce((s,i) => s + i.price, 0),
    speed: d.speed,
    answerSec: d.answerSec,
    label: d.label,
  };
}

// セット番号に応じて難易度を段階的に上げる
function levelForSet(setNo, totalSets, minL, maxL) {
  if (maxL <= minL || totalSets <= 1) return minL;
  const ratio = (setNo - 1) / (totalSets - 1);
  return Math.min(maxL, minL + Math.round(ratio * (maxL - minL)));
}

// ===== Redis =====
async function rGet(key) {
  const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
  });
  const d = await r.json();
  return d.result ? JSON.parse(d.result) : null;
}
async function rSet(key, value, ttl = ROOM_TTL) {
  await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}?EX=${ttl}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value)
  });
}

// ===== Pusher REST（ライブラリ不使用） =====
async function pusherTrigger(channel, event, data) {
  if (!PUSHER_APP_ID || !PUSHER_KEY || !PUSHER_SECRET) return;
  const body = JSON.stringify({ name: event, channel, data: JSON.stringify(data) });
  const bodyMd5 = crypto.createHash('md5').update(body).digest('hex');
  const ts = Math.floor(Date.now() / 1000);
  const path = `/apps/${PUSHER_APP_ID}/events`;
  const params = [
    `auth_key=${PUSHER_KEY}`,
    `auth_timestamp=${ts}`,
    `auth_version=1.0`,
    `body_md5=${bodyMd5}`,
  ].sort().join('&');
  const sig = crypto.createHmac('sha256', PUSHER_SECRET)
    .update(`POST\n${path}\n${params}`).digest('hex');
  const url = `https://api-${PUSHER_CLUSTER}.pusher.com${path}?${params}&auth_signature=${sig}`;
  try {
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  } catch(e) { /* 配信失敗は致命的ではない */ }
}

function publicRoom(room) {
  // 正解金額など秘匿すべき情報を落として返す
  const { questions, ...rest } = room;
  return rest;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;
  const body = req.method === 'POST' ? (typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {}) : {};

  try {
    // --- 設定確認（フロントがPusher接続情報を取得） ---
    if (action === 'config') {
      return res.status(200).json({
        key: PUSHER_KEY || null,
        cluster: PUSHER_CLUSTER,
        enabled: !!(PUSHER_KEY && PUSHER_SECRET && PUSHER_APP_ID),
      });
    }

    // --- ルーム作成 ---
    if (action === 'create') {
      const { playerId, name, sets, minLevel, maxLevel } = body;
      if (!playerId || !name) return res.status(400).json({ error: '名前が必要です' });
      const n = Math.max(1, Math.min(20, parseInt(sets) || 3));
      const minL = Math.max(1, Math.min(3, parseInt(minLevel) || 1));
      const maxL = Math.max(minL, Math.min(3, parseInt(maxLevel) || minL));

      // ルームIDはユーザー指定を優先（英数字・ハイフン・アンダーバーのみ）
      let code = (body.customCode || '').trim();
      if (code) {
        if (!/^[a-zA-Z0-9_-]{1,20}$/.test(code)) {
          return res.status(400).json({ error: 'ルームIDは英数字・ハイフン・アンダーバーのみ使えます' });
        }
        const existing = await rGet(`room:${code}`);
        if (existing && existing.state !== 'finished') {
          return res.status(409).json({ error: 'そのルームIDは使用中です' });
        }
      } else {
        for (let i = 0; i < 5; i++) {
          code = Math.random().toString(36).slice(2, 7).toUpperCase();
          if (!(await rGet(`room:${code}`))) break;
        }
      }

      const room = {
        code,
        hostId: playerId,
        settings: { sets: n, minLevel: minL, maxLevel: maxL },
        players: [{ id: playerId, name, sets: 0, diff: 0, ready: false }],
        state: 'waiting',
        setNo: 0,
        questions: [],
        answers: {},
        createdAt: Date.now(),
      };
      await rSet(`room:${code}`, room);
      return res.status(200).json({ room: publicRoom(room) });
    }

    // --- ルーム参加 ---
    if (action === 'join') {
      const { code, playerId, name } = body;
      if (!code || !playerId || !name) return res.status(400).json({ error: '入力が不足しています' });
      const key = `room:${code}`;
      const room = await rGet(key);
      if (!room) return res.status(404).json({ error: 'ルームが見つかりません' });
      if (room.state !== 'waiting') return res.status(409).json({ error: 'すでに開始しています' });

      const exists = room.players.find(p => p.id === playerId);
      if (!exists) {
        if (room.players.length >= MAX_PLAYERS) return res.status(409).json({ error: '満員です（最大10人）' });
        room.players.push({ id: playerId, name, sets: 0, diff: 0, ready: false });
        await rSet(key, room);
        await pusherTrigger(`room-${room.code}`, 'players', { players: room.players });
      }
      return res.status(200).json({ room: publicRoom(room) });
    }

    // --- 状態取得 ---
    if (action === 'state') {
      const code = req.query.code || '';
      const room = await rGet(`room:${code}`);
      if (!room) return res.status(404).json({ error: 'ルームが見つかりません' });
      return res.status(200).json({ room: publicRoom(room) });
    }

    // --- 退出 ---
    if (action === 'leave') {
      const { code, playerId } = body;
      const key = `room:${code||''}`;
      const room = await rGet(key);
      if (!room) return res.status(200).json({ ok: true });
      room.players = room.players.filter(p => p.id !== playerId);
      if (room.players.length === 0) {
        await rSet(key, room, 60);
      } else {
        if (room.hostId === playerId) room.hostId = room.players[0].id;
        await rSet(key, room);
        await pusherTrigger(`room-${room.code}`, 'players', { players: room.players, hostId: room.hostId });
      }
      return res.status(200).json({ ok: true });
    }

    // --- 練習開始（0試合目・イージー固定・勝敗に含めない） ---
    if (action === 'practice') {
      const { code, playerId } = body;
      const key = `room:${code||''}`;
      const room = await rGet(key);
      if (!room) return res.status(404).json({ error: 'ルームが見つかりません' });
      if (room.hostId !== playerId) return res.status(403).json({ error: 'ホストのみ開始できます' });

      const q = makeQuestion(1);
      room.state = 'practice';
      room.setNo = 0;
      room.questions = [q];
      room.answers = {};
      room.players = room.players.map(p => ({ ...p, ready: false }));
      const startAt = Date.now() + 3000;
      await rSet(key, room);
      await pusherTrigger(`room-${room.code}`, 'set-start', {
        setNo: 0, practice: true, startAt,
        items: q.items, speed: q.speed, answerSec: q.answerSec, label: q.label,
        totalSets: room.settings.sets,
      });
      return res.status(200).json({ ok: true });
    }

    // --- 準備OK（練習後、全員そろったら本戦開始） ---
    if (action === 'ready') {
      const { code, playerId } = body;
      const key = `room:${code||''}`;
      const room = await rGet(key);
      if (!room) return res.status(404).json({ error: 'ルームが見つかりません' });
      const p = room.players.find(x => x.id === playerId);
      if (p) p.ready = true;
      await rSet(key, room);
      await pusherTrigger(`room-${room.code}`, 'players', { players: room.players });

      if (room.players.length > 0 && room.players.every(x => x.ready)) {
        return await startSet(room, key, 1, res);
      }
      return res.status(200).json({ ok: true });
    }

    // --- 回答送信 ---
    if (action === 'answer') {
      const { code, playerId, value } = body;
      const key = `room:${code||''}`;
      const room = await rGet(key);
      if (!room) return res.status(404).json({ error: 'ルームが見つかりません' });
      const q = room.questions[room.questions.length - 1];
      if (!q) return res.status(400).json({ error: '出題がありません' });

      const v = parseInt(value) || 0;
      room.answers[playerId] = v;
      await rSet(key, room);
      await pusherTrigger(`room-${room.code}`, 'answered', {
        playerId,
        answeredCount: Object.keys(room.answers).length,
        totalPlayers: room.players.length,
      });

      // 全員回答済みなら即座に集計
      if (Object.keys(room.answers).length >= room.players.length) {
        return await finishSet(room, key, res);
      }
      return res.status(200).json({ ok: true });
    }

    // --- 集計（時間切れ時にクライアントから呼ばれる） ---
    if (action === 'finish') {
      const { code } = body;
      const key = `room:${code||''}`;
      const room = await rGet(key);
      if (!room) return res.status(404).json({ error: 'ルームが見つかりません' });
      if (room.state === 'result' || room.state === 'finished') return res.status(200).json({ ok: true });
      return await finishSet(room, key, res);
    }

    // --- 次のセットへ ---
    if (action === 'next') {
      const { code, playerId } = body;
      const key = `room:${code||''}`;
      const room = await rGet(key);
      if (!room) return res.status(404).json({ error: 'ルームが見つかりません' });
      if (room.hostId !== playerId) return res.status(403).json({ error: 'ホストのみ進行できます' });
      return await startSet(room, key, room.setNo + 1, res);
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  // ===== 内部関数 =====
  async function startSet(room, key, setNo, res) {
    const { sets, minLevel, maxLevel } = room.settings;
    if (setNo > sets) return await endGame(room, key, res);

    const level = levelForSet(setNo, sets, minLevel, maxLevel);
    const q = makeQuestion(level);
    room.state = 'playing';
    room.setNo = setNo;
    room.questions.push(q);
    room.answers = {};
    const startAt = Date.now() + 3000;
    await rSet(key, room);
    await pusherTrigger(`room-${room.code}`, 'set-start', {
      setNo, practice: false, startAt,
      items: q.items, speed: q.speed, answerSec: q.answerSec, label: q.label,
      totalSets: sets,
    });
    return res.status(200).json({ ok: true });
  }

  async function finishSet(room, key, res) {
    const q = room.questions[room.questions.length - 1];
    const isPractice = room.state === 'practice';
    const results = room.players.map(p => {
      const ans = room.answers[p.id];
      const answered = ans !== undefined;
      const correct = answered && ans === q.total;
      const gap = answered ? Math.abs(ans - q.total) : q.total;
      return { id: p.id, name: p.name, answer: answered ? ans : null, correct, gap };
    });

    if (!isPractice) {
      for (const p of room.players) {
        const r = results.find(x => x.id === p.id);
        if (r) { if (r.correct) p.sets += 1; p.diff += r.gap; }
      }
    }

    room.state = 'result';
    await rSet(key, room);
    await pusherTrigger(`room-${room.code}`, 'set-result', {
      setNo: room.setNo,
      practice: isPractice,
      total: q.total,
      results,
      players: room.players,
      isLast: !isPractice && room.setNo >= room.settings.sets,
    });
    return res.status(200).json({ ok: true });
  }

  async function endGame(room, key, res) {
    room.state = 'finished';
    const ranking = [...room.players].sort((a,b) => (b.sets - a.sets) || (a.diff - b.diff));
    await rSet(key, room);
    await pusherTrigger(`room-${room.code}`, 'game-end', { ranking });
    return res.status(200).json({ ok: true, ranking });
  }
}
