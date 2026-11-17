// api/auth.js - 個人アカウント（名前＋PIN）とログイン保持
//
// 保存キー:
//   account:{groupId}:{accountId}      … { id, name, salt, pinHash, ver, profile, createdAt }
//   account-name:{groupId}:{名前のハッシュ} … accountId（名前→アカウントの対応）
//   ※1人1キーにしてあるので、同時に登録されても他人の分を上書きしない
//   session:{token}      … { groupId, accountId, ver, ref }   （1年で自動失効・開くたびに延長）
//   handoff:{code}       … { groupId, accountId }             （10分・1回限り）
//   url-index:{リンクID}  … { groupId, name }  （api/groups.js が書く。リンク＋PINログイン用）
//   yg:{groupId}         … 寄せ書きの設定 { targets: { [名前]: { released, releasedAt, token } } }
//   yg-msgs:{groupId}:{名前のハッシュ} … Redisハッシュ。フィールド=書いた人のaccountId、値={from,text,at}
//   yg-token:{token}     … { groupId, name }（公開後に本人へ送るリンク用）
//   auth-fail:{groupId}:{accountId} … { n }                   （PIN間違いの回数・10分で消える）

import crypto from 'node:crypto';

const SESSION_SEC = 365 * 24 * 60 * 60;   // ログイン保持: 1年
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000; // 延長の書き込みは1日1回まで（Redis節約）
const HANDOFF_SEC = 10 * 60;
const MAX_FAIL = 5;
const LOCK_SEC = 10 * 60;
const COOKIE = 'sm_session';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const UPSTASH_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return res.status(500).json({ error: 'DB not configured' });

  async function redisGet(key) {
    const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : null;
  }
  async function redisSet(key, value, exSec) {
    const q = exSec ? `?EX=${exSec}` : '';
    await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}${q}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(value)
    });
  }
  async function redisDel(key) {
    await fetch(`${UPSTASH_URL}/del/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
  }

  const rand = (n) => crypto.randomBytes(n).toString('hex');
  const hashPin = (pin, salt) => crypto.scryptSync(String(pin), salt, 32).toString('hex');
  const safeEq = (a, b) => {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };
  const validPin = (p) => /^\d{4,8}$/.test(String(p || ''));

  function setCookie(token) {
    res.setHeader('Set-Cookie',
      `${COOKIE}=${token}; Path=/; Max-Age=${SESSION_SEC}; HttpOnly; Secure; SameSite=Lax`);
  }
  function clearCookie() {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
  }
  function readTokens() {
    const out = [];
    const h = req.headers['authorization'] || '';
    if (h.startsWith('Bearer ') && h.length > 7) out.push(h.slice(7).trim());
    const raw = req.headers['cookie'] || '';
    const m = raw.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]+)`));
    if (m && !out.includes(m[1])) out.push(m[1]);
    return out.filter(t => /^[a-f0-9]{32,}$/.test(t));
  }

  async function redisMget(keys) {
    if (!keys.length) return [];
    const r = await fetch(UPSTASH_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['MGET', ...keys])
    });
    const d = await r.json();
    return (d.result || []).map(v => { try { return v ? JSON.parse(v) : null; } catch (e) { return null; } });
  }

  // groups.js と同じ規則（s= の値、無ければパス）
  function linkId(url) {
    const s = String(url || '').match(/[?&]s=([A-Za-z0-9]+)/);
    if (s) return 's:' + s[1];
    const m = String(url || '').match(/^https?:\/\/[^\/]+(\/[^?#]*)/);
    return m ? 'p:' + m[1].replace(/\/+$/, '').toLowerCase() : null;
  }

  async function redisCmd(cmd) {
    const r = await fetch(UPSTASH_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd)
    });
    return (await r.json()).result;
  }

  // ---- 寄せ書き ----
  const ygKey = (g) => `yg:${g}`;
  const ygMsgKey = (g, name) => `yg-msgs:${g}:${nameHash(name)}`;
  const ygConfig = async (g) => (await redisGet(ygKey(g))) || { targets: {} };
  // 募集開始日（日本時間の YYYY-MM-DD）。未設定ならすぐ開始。開始前は書く側にも一切出さない
  const todayJst = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const ygStarted = (cfg) => !cfg.startAt || todayJst() >= cfg.startAt;
  async function ygMessages(g, name) {
    const flat = (await redisCmd(['HGETALL', ygMsgKey(g, name)])) || [];
    const out = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      try { out.push({ by: flat[i], ...JSON.parse(flat[i + 1]) }); } catch (e) {}
    }
    return out.sort((x, y) => String(x.at).localeCompare(String(y.at)));
  }

  const nameHash = (name) => crypto.createHash('sha1').update(String(name)).digest('hex').slice(0, 20);
  const accKey = (g, id) => `account:${g}:${id}`;
  const nameKey = (g, name) => `account-name:${g}:${nameHash(name)}`;
  const getMembers = async (g) => (await redisGet(`group:${g}`)) || [];
  const getAccount = (g, id) => redisGet(accKey(g, id));
  const saveAccount = (g, acc) => redisSet(accKey(g, acc.id), acc);
  async function findByName(g, name) {
    const id = await redisGet(nameKey(g, name));
    if (!id) return null;
    const acc = await getAccount(g, id);
    return (acc && acc.name === name) ? acc : null;
  }

  async function newSession(groupId, acc) {
    const token = rand(24);
    await redisSet(`session:${token}`,
      { groupId, accountId: acc.id, ver: acc.ver || 1, ref: Date.now() }, SESSION_SEC);
    setCookie(token);
    return token;
  }

  // ヘッダー（localStorage）とCookieのどちらか生きている方でログインを復元する
  async function currentSession() {
    for (const token of readTokens()) {
      const s = await redisGet(`session:${token}`);
      if (!s) continue;
      const acc = await getAccount(s.groupId, s.accountId);
      if (!acc || !acc.pinHash || (acc.ver || 1) !== s.ver) { await redisDel(`session:${token}`); continue; }
      return { token, s, acc };
    }
    return null;
  }

  async function publicMe(groupId, acc, token) {
    const members = await getMembers(groupId);
    const me = members.find(m => m.name === acc.name);
    return {
      ok: true, token, groupId, accountId: acc.id, name: acc.name,
      url: me ? me.url : null, inGroup: !!me, profile: acc.profile || {},
    };
  }

  function cleanProfile(p) {
    const out = {};
    if (!p || typeof p !== 'object') return out;
    if (typeof p.surveyUid === 'string' && /^[\w-]{1,40}$/.test(p.surveyUid)) out.surveyUid = p.surveyUid;
    if (p.memberColors && typeof p.memberColors === 'object') {
      const s = JSON.stringify(p.memberColors);
      if (s.length < 8000) out.memberColors = p.memberColors;
    }
    return out;
  }

  try {
    const action = req.query.action;
    const body = (req.body && typeof req.body === 'object') ? req.body : {};

    // ---- 自分は誰か（起動時に毎回呼ぶ。ここで期限を延長する） ----
    if (action === 'me') {
      const cur = await currentSession();
      if (!cur) { clearCookie(); return res.status(401).json({ error: 'not logged in' }); }
      if (Date.now() - (cur.s.ref || 0) > REFRESH_AFTER_MS) {
        await redisSet(`session:${cur.token}`, { ...cur.s, ref: Date.now() }, SESSION_SEC);
      }
      setCookie(cur.token);
      return res.status(200).json(await publicMe(cur.s.groupId, cur.acc, cur.token));
    }

    // ---- このグループでPIN設定済みの人の一覧（初回設定かログインかの出し分け用） ----
    if (action === 'status') {
      const { groupId } = req.query;
      if (!groupId) return res.status(400).json({ error: 'groupId required' });
      const members = await getMembers(groupId);
      const ids = await redisMget(members.map(m => nameKey(groupId, m.name)));
      const pairs = members.map((m, i) => ({ name: m.name, id: ids[i] })).filter(x => x.id);
      const accs = await redisMget(pairs.map(x => accKey(groupId, x.id)));
      return res.status(200).json({
        registered: pairs.filter((x, i) => accs[i] && accs[i].pinHash && accs[i].name === x.name).map(x => x.name)
      });
    }

    // ---- 寄せ書き：公開リンクから読む（本人に送るリンク。ログイン不要） ----
    if (action === 'yg-view') {
      const token = String(req.query.token || '');
      if (!/^[a-f0-9]{24,}$/.test(token)) return res.status(400).json({ error: 'リンクが正しくありません' });
      const t = await redisGet(`yg-token:${token}`);
      if (!t) return res.status(404).json({ error: 'この寄せ書きは見つかりません' });
      const cfg = await ygConfig(t.groupId);
      const tg = cfg.targets[t.name];
      if (!tg || !tg.released || tg.token !== token) return res.status(404).json({ error: 'この寄せ書きは今は公開されていません' });
      const msgs = await ygMessages(t.groupId, t.name);
      return res.status(200).json({ ok: true, name: t.name, messages: msgs.map(m => ({ from: m.from, text: m.text })) });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    // ---- シフターリンクから「どのグループの誰か」を引く（最初の画面のリンク＋PINログイン用） ----
    if (action === 'link-lookup') {
      const url = String(body.url || '');
      if (!url.includes('ciftr.jp')) return res.status(400).json({ error: 'ciftr.jpのリンクを貼ってください' });
      const id = linkId(url);
      if (!id) return res.status(400).json({ error: 'リンクの形が正しくありません' });
      const hit = await redisGet(`url-index:${id}`);
      if (!hit) return res.status(200).json({ found: false });
      // 対応表が古い場合に備えて、今もそのグループにそのリンクで居るかを確かめる
      const members = await getMembers(hit.groupId);
      const me = members.find(m => linkId(m.url) === id);
      if (!me) return res.status(200).json({ found: false });
      const acc = await findByName(hit.groupId, me.name);
      return res.status(200).json({ found: true, groupId: hit.groupId, name: me.name, hasPin: !!(acc && acc.pinHash) });
    }

    // ---- 初回：PINを決める ----
    if (action === 'register') {
      const { groupId, name, pin, profile } = body;
      if (!groupId || !name) return res.status(400).json({ error: 'missing fields' });
      if (!validPin(pin)) return res.status(400).json({ error: 'PINは数字4〜8桁で決めてください' });
      const members = await getMembers(groupId);
      if (!members.some(m => m.name === name)) return res.status(404).json({ error: 'グループにその名前が見つかりません' });

      let acc = await findByName(groupId, name);
      if (acc && acc.pinHash) return res.status(409).json({ error: 'この名前はPIN設定済みです。PINを入力してください' });

      const salt = rand(16);
      if (!acc) {
        acc = { id: 'a_' + rand(6), name, ver: 1, profile: {}, createdAt: new Date().toISOString() };
      }
      acc.salt = salt;
      acc.pinHash = hashPin(pin, salt);
      acc.profile = { ...(acc.profile || {}), ...cleanProfile(profile) };
      await saveAccount(groupId, acc);
      await redisSet(nameKey(groupId, name), acc.id);
      const token = await newSession(groupId, acc);
      return res.status(200).json(await publicMe(groupId, acc, token));
    }

    // ---- ログイン ----
    if (action === 'login') {
      const { groupId, name, pin } = body;
      if (!groupId || !name || !pin) return res.status(400).json({ error: 'missing fields' });
      const acc = await findByName(groupId, name);
      if (!acc || !acc.pinHash) return res.status(404).json({ error: 'まだPINが設定されていません', needRegister: true });

      const failKey = `auth-fail:${groupId}:${acc.id}`;
      const fail = (await redisGet(failKey)) || { n: 0 };
      if (fail.n >= MAX_FAIL) return res.status(429).json({ error: '間違いが続いたので10分ほど空けてください' });

      if (!safeEq(hashPin(pin, acc.salt), acc.pinHash)) {
        await redisSet(failKey, { n: fail.n + 1 }, LOCK_SEC);
        return res.status(401).json({ error: `PINが違います（あと${Math.max(0, MAX_FAIL - fail.n - 1)}回）` });
      }
      if (fail.n) await redisDel(failKey);
      const token = await newSession(groupId, acc);
      return res.status(200).json(await publicMe(groupId, acc, token));
    }

    // ---- 引き継ぎコードで入る（PIN不要・10分・1回限り） ----
    if (action === 'handoff-use') {
      const code = String(body.code || '');
      if (!/^[a-f0-9]{24,}$/.test(code)) return res.status(400).json({ error: '引き継ぎリンクが正しくありません' });
      const h = await redisGet(`handoff:${code}`);
      if (!h) return res.status(410).json({ error: '引き継ぎリンクの期限が切れています' });
      await redisDel(`handoff:${code}`);
      const acc = await getAccount(h.groupId, h.accountId);
      if (!acc || !acc.pinHash) return res.status(410).json({ error: 'アカウントが見つかりません' });
      const token = await newSession(h.groupId, acc);
      return res.status(200).json(await publicMe(h.groupId, acc, token));
    }

    // ---- 管理者：PINリセット（プロフィールは残し、全端末のログインを切る） ----
    if (action === 'admin-reset') {
      const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
      if (!ADMIN_PASSWORD) return res.status(500).json({ error: 'ADMIN_PASSWORD not configured' });
      const { adminPassword, groupId, name } = body;
      if (!safeEq(adminPassword || '', ADMIN_PASSWORD)) return res.status(401).json({ error: '管理者パスワードが違います' });
      if (!groupId || !name) return res.status(400).json({ error: 'missing fields' });
      const acc = await findByName(groupId, name);
      if (!acc) return res.status(200).json({ ok: true, note: 'no account' });
      delete acc.pinHash; delete acc.salt;
      acc.ver = (acc.ver || 1) + 1;
      await saveAccount(groupId, acc);
      await redisDel(`auth-fail:${groupId}:${acc.id}`);
      return res.status(200).json({ ok: true });
    }

    // ---- 寄せ書き：管理者の操作（対象の追加・公開・取り消し） ----
    if (action === 'yg-admin') {
      const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
      if (!ADMIN_PASSWORD) return res.status(500).json({ error: 'ADMIN_PASSWORD not configured' });
      const { adminPassword, groupId, op, name } = body;
      if (!safeEq(adminPassword || '', ADMIN_PASSWORD)) return res.status(401).json({ error: '管理者パスワードが違います' });
      if (!groupId) return res.status(400).json({ error: 'missing fields' });
      const cfg = await ygConfig(groupId);

      if (op === 'schedule') {
        const date = String(body.date || '');
        if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: '日付の形が正しくありません' });
        if (date) cfg.startAt = date; else delete cfg.startAt;
        await redisSet(ygKey(groupId), cfg);
      } else if (op && op !== 'list') {
        if (!name) return res.status(400).json({ error: 'missing fields' });
        if (op === 'add') {
          const members = await getMembers(groupId);
          if (!members.some(m => m.name === name)) return res.status(404).json({ error: 'グループにその名前が見つかりません' });
          if (!cfg.targets[name]) cfg.targets[name] = { released: false, addedAt: new Date().toISOString() };
          // 最初の対象を追加する時に開始日も一緒に決める（うっかり即公開にならないように）
          const date = String(body.date || '');
          if (!cfg.startAt && /^\d{4}-\d{2}-\d{2}$/.test(date)) cfg.startAt = date;
        } else if (!cfg.targets[name]) {
          return res.status(404).json({ error: '対象に入っていません' });
        } else if (op === 'release') {
          const tg = cfg.targets[name];
          if (!tg.token) { tg.token = rand(16); await redisSet(`yg-token:${tg.token}`, { groupId, name }); }
          tg.released = true; tg.releasedAt = new Date().toISOString();
        } else if (op === 'unrelease') {
          cfg.targets[name].released = false;
        } else if (op === 'remove') {
          if (cfg.targets[name].token) await redisDel(`yg-token:${cfg.targets[name].token}`);
          delete cfg.targets[name];
          await redisDel(ygMsgKey(groupId, name));   // 集まったメッセージも消える
        } else {
          return res.status(400).json({ error: 'unknown op' });
        }
        await redisSet(ygKey(groupId), cfg);
      }

      const list = [];
      for (const [n, tg] of Object.entries(cfg.targets)) {
        const count = Number(await redisCmd(['HLEN', ygMsgKey(groupId, n)])) || 0;
        list.push({ name: n, released: !!tg.released, count, token: tg.released ? tg.token : null });
      }
      return res.status(200).json({ ok: true, targets: list, startAt: cfg.startAt || null, started: ygStarted(cfg) });
    }

    // ---- ここから下はログイン必須 ----
    const cur = await currentSession();
    if (!cur) return res.status(401).json({ error: 'not logged in' });
    const { s, acc, token } = cur;

    if (action === 'logout') {
      await redisDel(`session:${token}`);
      clearCookie();
      return res.status(200).json({ ok: true });
    }

    // ---- 寄せ書き：自分が書ける相手と、自分宛て（公開後のみ）を返す ----
    if (action === 'yg-list') {
      const cfg = await ygConfig(s.groupId);
      const mineCfg = cfg.targets[acc.name];
      // 自分が対象で未公開の間は、寄せ書きの存在そのものを見せない
      if (mineCfg && !mineCfg.released) return res.status(200).json({ ok: true, targets: [], mine: null });
      const members = await getMembers(s.groupId);
      const targets = [];
      for (const n of (ygStarted(cfg) ? Object.keys(cfg.targets) : [])) {
        if (n === acc.name || !members.some(m => m.name === n)) continue;
        const raw = await redisCmd(['HGET', ygMsgKey(s.groupId, n), acc.id]);
        let myText = '';
        try { if (raw) myText = JSON.parse(raw).text || ''; } catch (e) {}
        targets.push({ name: n, myText });
      }
      let mine = null;
      if (mineCfg && mineCfg.released) {
        const msgs = await ygMessages(s.groupId, acc.name);
        mine = { name: acc.name, releasedAt: mineCfg.releasedAt, messages: msgs.map(m => ({ from: m.from, text: m.text })) };
      }
      return res.status(200).json({ ok: true, targets, mine, startAt: targets.length ? (cfg.startAt || 'now') : null });
    }

    // ---- 寄せ書き：書く（1人につき1通。書き直すと上書き、空にすると取り消し） ----
    if (action === 'yg-write') {
      const target = String(body.target || '');
      const text = String(body.text || '').trim().slice(0, 400);
      const cfg = await ygConfig(s.groupId);
      if (!cfg.targets[target]) return res.status(404).json({ error: 'この人は寄せ書きの対象ではありません' });
      if (!ygStarted(cfg)) return res.status(403).json({ error: 'まだ受付前です' });
      if (target === acc.name) return res.status(403).json({ error: '自分宛てには書けません' });
      if (cfg.targets[acc.name] && !cfg.targets[acc.name].released) return res.status(403).json({ error: '今は書けません' });
      if (!text) { await redisCmd(['HDEL', ygMsgKey(s.groupId, target), acc.id]); return res.status(200).json({ ok: true, deleted: true }); }
      await redisCmd(['HSET', ygMsgKey(s.groupId, target), acc.id,
        JSON.stringify({ from: acc.name, text, at: new Date().toISOString() })]);
      return res.status(200).json({ ok: true });
    }

    if (action === 'handoff-create') {
      const code = rand(16);
      await redisSet(`handoff:${code}`, { groupId: s.groupId, accountId: acc.id }, HANDOFF_SEC);
      return res.status(200).json({ ok: true, code, expiresInSec: HANDOFF_SEC });
    }

    if (action === 'change-pin') {
      const { oldPin, newPin } = body;
      if (!safeEq(hashPin(oldPin || '', acc.salt), acc.pinHash)) return res.status(401).json({ error: '今のPINが違います' });
      if (!validPin(newPin)) return res.status(400).json({ error: 'PINは数字4〜8桁で決めてください' });
      acc.salt = rand(16);
      acc.pinHash = hashPin(newPin, acc.salt);
      acc.ver = (acc.ver || 1) + 1;           // 他の端末のログインは切れる
      await saveAccount(s.groupId, acc);
      await redisDel(`session:${token}`);
      const t2 = await newSession(s.groupId, acc); // この端末はそのまま継続
      return res.status(200).json(await publicMe(s.groupId, acc, t2));
    }

    if (action === 'profile') {
      acc.profile = { ...(acc.profile || {}), ...cleanProfile(body.profile) };
      await saveAccount(s.groupId, acc);
      return res.status(200).json({ ok: true, profile: acc.profile });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
