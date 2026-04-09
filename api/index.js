// 回数券管理SaaS — マルチテナント版 Vercel サーバーレスAPI
// 全機能: ルーム管理, 売上レポート, 予約メモ, 金額管理, 施術メモ, 有効期限, CSVエクスポート, 誕生日, スタッフ管理, LINE連携
const { Redis } = require('@upstash/redis');
const crypto = require('crypto');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// === Redisキー構造 ===
const ROOMS_INDEX = 'cp:rooms'; // 全ルームID一覧（Set）
const roomKey = (id) => `cp:${id}:data`;
const roomMembersKey = (id) => `cp:${id}:members`;
const roomLineFriendsKey = (id) => `cp:${id}:line_friends`;
const sessionKey = (token) => `cp:session:${token}`;
const SESSION_TTL = 60 * 60 * 24 * 30; // 30日

// === デフォルト設定 ===
const DEFAULT_SETTINGS = {
  ticketPrices: { '4': 20000, '8': 36000, '16': 64000, '24': 84000, '48': 144000 },
  expiryMonths: 12,
  staffList: [],
};

// === ヘルパー関数 ===
function parseData(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') return JSON.parse(raw);
  return raw;
}

async function getRoomData(roomId) {
  const raw = await redis.get(roomKey(roomId));
  return parseData(raw);
}

async function saveRoomData(roomId, data) {
  await redis.set(roomKey(roomId), JSON.stringify(data));
}

async function getMembers(roomId) {
  const raw = await redis.get(roomMembersKey(roomId));
  if (!raw) return [];
  return parseData(raw) || [];
}

async function saveMembers(roomId, members) {
  await redis.set(roomMembersKey(roomId), JSON.stringify(members));
}

async function getLineFriends(roomId) {
  const raw = await redis.get(roomLineFriendsKey(roomId));
  if (!raw) return [];
  return parseData(raw) || [];
}

async function saveLineFriends(roomId, friends) {
  await redis.set(roomLineFriendsKey(roomId), JSON.stringify(friends));
}

// セッション検証 → roomIdを返す
async function validateSession(req) {
  const token = req.headers['x-auth-token'] || '';
  if (!token) return null;
  const raw = await redis.get(sessionKey(token));
  if (!raw) return null;
  const session = parseData(raw);
  return session; // { roomId, deviceId, role }
}

// メンバー追跡（deviceIdベース）
function trackMember(members, name, deviceId) {
  if (!name || !deviceId) return members;
  const byDevice = members.find(m => m.deviceId === deviceId);
  if (byDevice) {
    byDevice.name = name;
    byDevice.lastSeen = new Date().toISOString();
  } else {
    members.push({ name, deviceId, role: 'staff', joinedAt: new Date().toISOString(), lastSeen: new Date().toISOString() });
  }
  return members;
}

// パスコードのハッシュ化（SHA-256）
function hashPasscode(passcode) {
  return crypto.createHash('sha256').update(passcode).digest('hex');
}

// 利用ログを正規化（旧形式の文字列対応）
function normalizeLog(entry) {
  if (typeof entry === 'string') return { date: entry, memo: '', staff: '' };
  return entry;
}

// LINE メッセージ送信
async function sendLineMessage(token, userId, messages) {
  if (!token) return { error: 'LINE未設定' };
  const r = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ to: userId, messages }),
  });
  return r.ok ? { status: 'ok' } : { error: await r.text() };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Auth-Token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const url = new URL(req.url, `https://${req.headers.host}`);
  const pathname = url.pathname;
  const body = req.body || {};

  try {
    // ===========================
    // ルーム管理（認証不要）
    // ===========================

    // === ルーム作成 ===
    if (pathname === '/api/create' && req.method === 'POST') {
      const storeName = (body.name || '').trim();
      const creator = (body.creator || '').trim();
      const passcode = (body.passcode || '').trim();
      const deviceId = (body.deviceId || '').trim();
      if (!storeName) return res.status(400).json({ error: '店舗名を入力してください' });
      if (!passcode || passcode.length < 4) return res.status(400).json({ error: 'パスコードは4文字以上で設定してください' });

      const roomId = crypto.randomBytes(4).toString('hex');
      const data = {
        id: roomId,
        name: storeName,
        admin: creator || '管理者',
        adminDeviceId: deviceId,
        passcodeHash: hashPasscode(passcode),
        customers: [],
        settings: { ...DEFAULT_SETTINGS },
        lineConfig: { channelAccessToken: '', channelSecret: '' },
        createdAt: new Date().toISOString(),
      };
      await saveRoomData(roomId, data);
      await redis.sadd(ROOMS_INDEX, roomId);

      // 作成者をメンバーに追加
      const members = [{ name: creator || '管理者', deviceId, role: 'admin', joinedAt: new Date().toISOString(), lastSeen: new Date().toISOString() }];
      await saveMembers(roomId, members);

      // セッション発行
      const token = crypto.randomBytes(16).toString('hex');
      await redis.set(sessionKey(token), JSON.stringify({ roomId, deviceId, role: 'admin' }), { ex: SESSION_TTL });

      return res.status(200).json({ id: roomId, token, name: storeName });
    }

    // === ルームログイン ===
    if (pathname === '/api/login' && req.method === 'POST') {
      const roomId = (body.roomId || '').trim();
      const passcode = (body.passcode || '').trim();
      const userName = (body.userName || '').trim();
      const deviceId = (body.deviceId || '').trim();

      if (!roomId) return res.status(400).json({ error: 'ルームIDが必要です' });
      const data = await getRoomData(roomId);
      if (!data) return res.status(404).json({ error: '店舗が見つかりません' });
      if (data.passcodeHash !== hashPasscode(passcode)) return res.status(401).json({ error: 'パスコードが違います' });

      // メンバー追跡
      const members = await getMembers(roomId);
      const isAdmin = data.adminDeviceId === deviceId;
      const role = isAdmin ? 'admin' : 'staff';
      trackMember(members, userName || '名称未設定', deviceId);
      // ロール更新
      const me = members.find(m => m.deviceId === deviceId);
      if (me) me.role = role;
      await saveMembers(roomId, members);

      // セッション発行
      const token = crypto.randomBytes(16).toString('hex');
      await redis.set(sessionKey(token), JSON.stringify({ roomId, deviceId, role }), { ex: SESSION_TTL });

      return res.status(200).json({ token, name: data.name, role });
    }

    // === ルーム存在確認 ===
    if (pathname === '/api/check-room' && req.method === 'POST') {
      const roomId = (body.roomId || '').trim();
      const data = await getRoomData(roomId);
      if (!data) return res.status(404).json({ error: '見つかりません' });
      return res.status(200).json({ name: data.name });
    }

    // ===========================
    // LINE Webhook（認証不要・最優先）
    // ===========================
    if (pathname.match(/^\/api\/store\/[^/]+\/line\/webhook$/)) {
      const roomId = pathname.split('/')[3];
      if (req.method === 'GET') return res.status(200).json({ status: 'ok' });
      if (req.method === 'POST') {
        const data = await getRoomData(roomId);
        if (!data) return res.status(200).json({ status: 'ok' });
        const lineToken = data.lineConfig?.channelAccessToken;
        if (!lineToken) return res.status(200).json({ status: 'ok' });

        const events = body.events || [];
        const friends = await getLineFriends(roomId);
        for (const ev of events) {
          if (ev.type === 'follow') {
            const userId = ev.source?.userId;
            if (userId && !friends.find(f => f.userId === userId)) {
              let displayName = '';
              try {
                const pr = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
                  headers: { 'Authorization': `Bearer ${lineToken}` },
                });
                if (pr.ok) { const pj = await pr.json(); displayName = pj.displayName || ''; }
              } catch(e) {}
              friends.push({ userId, displayName, followedAt: new Date().toISOString(), linked: '' });
              await saveLineFriends(roomId, friends);
              await sendLineMessage(lineToken, userId, [{ type: 'text', text: `${data.name}へようこそ！\n回数券の有効期限やお得な情報をお届けします💆\n\n「残り」→ 回数券確認\n「予約」→ 次回予約確認\n「メニュー」→ 機能一覧` }]);
            }
          } else if (ev.type === 'unfollow') {
            const userId = ev.source?.userId;
            const idx = friends.findIndex(f => f.userId === userId);
            if (idx !== -1) { friends.splice(idx, 1); await saveLineFriends(roomId, friends); }
          } else if (ev.type === 'message' && ev.message?.type === 'text') {
            const userId = ev.source?.userId;
            const text = (ev.message.text || '').trim();
            const friend = friends.find(f => f.userId === userId);
            if (!friend?.linked) {
              if (text.match(/残り|回数|予約|チケット/)) {
                await sendLineMessage(lineToken, userId, [{ type: 'text', text: 'まだお客様情報とリンクされていません。\nスタッフにお声がけください🙏' }]);
              }
              continue;
            }
            const customer = data.customers.find(c => c.cid === friend.linked);
            if (!customer) continue;
            const settings = data.settings || DEFAULT_SETTINGS;

            if (text.match(/残り|回数|チケット|券/)) {
              const activeTickets = customer.tickets.filter(t => t.remaining > 0);
              if (!activeTickets.length) {
                await sendLineMessage(lineToken, userId, [{ type: 'text', text: `${customer.name}様\n\n現在有効な回数券はございません。\nまたのご利用をお待ちしております🙏` }]);
              } else {
                let msg = `${customer.name}様の回数券情報📋\n━━━━━━━━━━\n`;
                activeTickets.forEach(t => {
                  let expInfo = '';
                  if (settings.expiryMonths > 0) {
                    const exp = new Date(t.purchasedAt);
                    exp.setMonth(exp.getMonth() + settings.expiryMonths);
                    const dl = Math.floor((exp - Date.now()) / 864e5);
                    expInfo = dl > 0 ? `（あと${dl}日）` : '（期限切れ）';
                  }
                  msg += `\n🎫 ${t.type}回券 残${t.remaining}回 ${expInfo}`;
                });
                msg += `\n\n━━━━━━━━━━\n${data.name}`;
                await sendLineMessage(lineToken, userId, [{ type: 'text', text: msg }]);
              }
            } else if (text.match(/予約|次回|いつ/)) {
              const appt = customer.nextAppointment;
              await sendLineMessage(lineToken, userId, [{ type: 'text', text: appt
                ? `${customer.name}様\n\n📅 次回ご予約: ${appt}\nお待ちしております✨\n━━━━━━━━━━\n${data.name}`
                : `${customer.name}様\n\n現在ご予約は入っておりません。\nご都合の良い日時をお知らせください📅\n━━━━━━━━━━\n${data.name}` }]);
            } else if (text.match(/メニュー|できること|ヘルプ|help/i)) {
              await sendLineMessage(lineToken, userId, [{ type: 'text', text: `${data.name} LINEメニュー📋\n━━━━━━━━━━\n「残り」→ 回数券の残数確認\n「予約」→ 次回予約の確認\n「メニュー」→ この表示\n━━━━━━━━━━` }]);
            }
          }
        }
        return res.status(200).json({ status: 'ok' });
      }
    }

    // ===========================
    // 以下は認証必須エンドポイント
    // ===========================
    const session = await validateSession(req);

    // /api/store/{roomId}/xxx パスの解析
    const storeMatch = pathname.match(/^\/api\/store\/([^/]+)\/(.+)$/);
    if (!storeMatch) return res.status(404).json({ error: 'Not found' });

    const roomId = storeMatch[1];
    const action = storeMatch[2];

    if (!session || session.roomId !== roomId) return res.status(401).json({ error: '認証が必要です。再ログインしてください。' });
    const isAdmin = session.role === 'admin';

    // ルームデータ取得
    const data = await getRoomData(roomId);
    if (!data) return res.status(404).json({ error: '店舗が見つかりません' });

    // === データ取得 ===
    if (action === 'data' && req.method === 'GET') {
      const settings = { ...DEFAULT_SETTINGS, ...data.settings };
      // アラート計算
      const now = Date.now();
      const alerts = { month1: [], month3: [], month6: [], expiring: [], birthdayMonth: [], todayAppt: [] };
      const currentMonth = new Date().getMonth() + 1;
      const today = new Date().toISOString().split('T')[0];
      data.customers.forEach(c => {
        const last = c.lastVisit || c.tickets?.map(t => t.usageLog?.map(l => normalizeLog(l).date).sort().pop()).filter(Boolean).sort().pop();
        if (last) {
          const diff = Math.floor((now - new Date(last).getTime()) / 864e5);
          if (diff >= 180) alerts.month6.push(c);
          else if (diff >= 90) alerts.month3.push(c);
          else if (diff >= 30) alerts.month1.push(c);
        }
        if (c.birthday) { const bm = parseInt(c.birthday.split('-')[1]); if (bm === currentMonth) alerts.birthdayMonth.push(c); }
        if (c.nextAppointment === today) alerts.todayAppt.push(c);
        if (settings.expiryMonths > 0) {
          c.tickets?.forEach(t => {
            if (t.remaining <= 0) return;
            const exp = new Date(t.purchasedAt); exp.setMonth(exp.getMonth() + settings.expiryMonths);
            const dl = Math.floor((exp - now) / 864e5);
            if (dl <= 30 && dl >= 0) alerts.expiring.push({ ...c, _ticketType: t.type, _daysLeft: dl });
          });
        }
      });
      return res.status(200).json({
        name: data.name, admin: data.admin, role: session.role,
        customers: data.customers, settings, alerts,
        hasLine: !!(data.lineConfig?.channelAccessToken),
      });
    }

    // === 顧客追加 ===
    if (action === 'customer' && req.method === 'POST') {
      const name = (body.name || '').trim();
      if (!name) return res.status(400).json({ error: '名前を入力してください' });
      if (data.customers.find(c => c.name === name)) return res.status(400).json({ error: `${name}は登録済みです` });
      const customer = {
        cid: crypto.randomBytes(4).toString('hex'), name,
        phone: (body.phone || '').trim(), memo: (body.memo || '').trim(),
        birthday: (body.birthday || '').trim(), nextAppointment: '',
        tickets: [], lastVisit: null, createdAt: new Date().toISOString(),
      };
      data.customers.push(customer);
      await saveRoomData(roomId, data);
      return res.status(200).json({ status: 'ok', customer });
    }

    // === 顧客更新 ===
    if (action === 'customer/update' && req.method === 'POST') {
      const c = data.customers.find(c => c.cid === body.cid);
      if (!c) return res.status(404).json({ error: '見つかりません' });
      if (body.name !== undefined) c.name = body.name.trim();
      if (body.phone !== undefined) c.phone = body.phone.trim();
      if (body.memo !== undefined) c.memo = body.memo.trim();
      if (body.birthday !== undefined) c.birthday = body.birthday;
      if (body.nextAppointment !== undefined) c.nextAppointment = body.nextAppointment;
      await saveRoomData(roomId, data);
      return res.status(200).json({ status: 'ok' });
    }

    // === 顧客削除（管理者のみ） ===
    if (action === 'customer/delete' && req.method === 'POST') {
      if (!isAdmin) return res.status(403).json({ error: '管理者のみ削除できます' });
      data.customers = data.customers.filter(c => c.cid !== body.cid);
      await saveRoomData(roomId, data);
      return res.status(200).json({ status: 'ok' });
    }

    // === 顧客一括削除（管理者のみ） ===
    if (action === 'customer/bulk-delete' && req.method === 'POST') {
      if (!isAdmin) return res.status(403).json({ error: '管理者のみ削除できます' });
      const cids = body.cids || [];
      if (cids.length === 0) { const count = data.customers.length; data.customers = []; await saveRoomData(roomId, data); return res.status(200).json({ status: 'ok', deleted: count }); }
      const before = data.customers.length;
      data.customers = data.customers.filter(c => !cids.includes(c.cid));
      await saveRoomData(roomId, data);
      return res.status(200).json({ status: 'ok', deleted: before - data.customers.length });
    }

    // === 回数券追加 ===
    if (action === 'ticket/add' && req.method === 'POST') {
      const c = data.customers.find(c => c.cid === body.cid);
      if (!c) return res.status(404).json({ error: '見つかりません' });
      c.tickets.push({
        tid: crypto.randomBytes(4).toString('hex'),
        type: parseInt(body.type) || 4,
        remaining: parseInt(body.type) || 4,
        purchasedAt: body.date || new Date().toISOString().split('T')[0],
        usageLog: [],
      });
      await saveRoomData(roomId, data);
      return res.status(200).json({ status: 'ok' });
    }

    // === 回数券利用 ===
    if (action === 'ticket/use' && req.method === 'POST') {
      const c = data.customers.find(c => c.cid === body.cid);
      if (!c) return res.status(404).json({ error: '見つかりません' });
      const t = c.tickets.find(t => t.tid === body.tid);
      if (!t || t.remaining <= 0) return res.status(400).json({ error: '利用できません' });
      t.remaining--;
      const logEntry = { date: body.date || new Date().toISOString().split('T')[0], memo: (body.memo || '').trim(), staff: (body.staff || '').trim() };
      t.usageLog.push(logEntry);
      c.lastVisit = logEntry.date;
      await saveRoomData(roomId, data);
      return res.status(200).json({ status: 'ok', remaining: t.remaining });
    }

    // === 回数券削除 ===
    if (action === 'ticket/delete' && req.method === 'POST') {
      const c = data.customers.find(c => c.cid === body.cid);
      if (!c) return res.status(404).json({ error: '見つかりません' });
      c.tickets = c.tickets.filter(t => t.tid !== body.tid);
      await saveRoomData(roomId, data);
      return res.status(200).json({ status: 'ok' });
    }

    // === 設定取得・更新 ===
    if (action === 'settings' && req.method === 'POST') {
      if (!isAdmin) return res.status(403).json({ error: '管理者のみ変更できます' });
      data.settings = { ...data.settings, ...body };
      await saveRoomData(roomId, data);
      return res.status(200).json({ status: 'ok' });
    }

    // === レポート ===
    if (action === 'report' && req.method === 'GET') {
      const monthly = {};
      const settings = { ...DEFAULT_SETTINGS, ...data.settings };
      data.customers.forEach(c => {
        c.tickets?.forEach(t => {
          const pm = t.purchasedAt?.substring(0, 7);
          if (pm) { if (!monthly[pm]) monthly[pm] = { purchased: 0, used: 0, revenue: 0, staffCount: {} }; monthly[pm].purchased++; monthly[pm].revenue += settings.ticketPrices?.[t.type] || 0; }
          t.usageLog?.forEach(log => {
            const e = normalizeLog(log);
            const um = e.date?.substring(0, 7);
            if (um) { if (!monthly[um]) monthly[um] = { purchased: 0, used: 0, revenue: 0, staffCount: {} }; monthly[um].used++; if (e.staff) monthly[um].staffCount[e.staff] = (monthly[um].staffCount[e.staff] || 0) + 1; }
          });
        });
      });
      return res.status(200).json({ monthly });
    }

    // === CSVエクスポート ===
    if (action === 'export' && req.method === 'GET') {
      const type = url.searchParams.get('type') || 'customers';
      let csv = '';
      if (type === 'customers') {
        csv = '\ufeff名前,電話番号,誕生日,メモ,有効回数券,次回予約\n';
        data.customers.forEach(c => {
          const at = c.tickets?.filter(t => t.remaining > 0).map(t => `${t.type}回券残${t.remaining}`).join('/') || '';
          csv += `"${c.name}","${c.phone || ''}","${c.birthday || ''}","${(c.memo || '').replace(/"/g, '""')}","${at}","${c.nextAppointment || ''}"\n`;
        });
      } else {
        csv = '\ufeff名前,日付,回数券,スタッフ,施術メモ\n';
        data.customers.forEach(c => {
          c.tickets?.forEach(t => t.usageLog?.forEach(log => {
            const e = normalizeLog(log);
            csv += `"${c.name}","${e.date}","${t.type}回券","${e.staff || ''}","${(e.memo || '').replace(/"/g, '""')}"\n`;
          }));
        });
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${type}_${new Date().toISOString().split('T')[0]}.csv"`);
      return res.send(csv);
    }

    // === CSV一括インポート ===
    if (action === 'bulk-import' && req.method === 'POST') {
      const items = body.items || [];
      if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'データがありません' });
      if (items.length > 500) return res.status(400).json({ error: '500件まで' });
      const added = [], errors = [];
      for (let i = 0; i < items.length; i++) {
        const name = (items[i].name || '').trim();
        if (!name) { errors.push({ row: i + 1, error: '名前が空' }); continue; }
        if (data.customers.find(c => c.name === name)) { errors.push({ row: i + 1, error: `${name}は登録済み` }); continue; }
        const customer = {
          cid: crypto.randomBytes(4).toString('hex'), name,
          phone: (items[i].phone || '').trim(), memo: (items[i].memo || '').trim(),
          birthday: (items[i].birthday || '').trim(), nextAppointment: '',
          tickets: [], lastVisit: (items[i].lastVisit || '').trim() || null,
          createdAt: new Date().toISOString(),
        };
        const ticketTotal = parseInt(items[i].ticketTotal) || 0;
        const ticketRemain = parseInt(items[i].ticketRemain) || 0;
        if (ticketTotal > 0) {
          customer.tickets.push({
            tid: crypto.randomBytes(4).toString('hex'), type: ticketTotal, remaining: ticketRemain,
            purchasedAt: customer.lastVisit || new Date().toISOString().split('T')[0], usageLog: [],
          });
        }
        data.customers.push(customer);
        added.push(customer);
      }
      await saveRoomData(roomId, data);
      return res.status(200).json({ status: 'ok', added: added.length, errors });
    }

    // === パスコード変更（管理者のみ） ===
    if (action === 'change-passcode' && req.method === 'POST') {
      if (!isAdmin) return res.status(403).json({ error: '管理者のみ変更できます' });
      const current = (body.current || '').trim();
      const newPass = (body.newPasscode || '').trim();
      if (data.passcodeHash !== hashPasscode(current)) return res.status(400).json({ error: '現在のパスコードが違います' });
      if (!newPass || newPass.length < 4) return res.status(400).json({ error: '4文字以上で設定してください' });
      data.passcodeHash = hashPasscode(newPass);
      await saveRoomData(roomId, data);
      return res.status(200).json({ status: 'ok' });
    }

    // === 管理権譲渡（管理者のみ） ===
    if (action === 'transfer-admin' && req.method === 'POST') {
      if (!isAdmin) return res.status(403).json({ error: '管理者のみ実行できます' });
      const newAdminDeviceId = (body.newAdminDeviceId || '').trim();
      const members = await getMembers(roomId);
      const newAdmin = members.find(m => m.deviceId === newAdminDeviceId);
      if (!newAdmin) return res.status(404).json({ error: 'メンバーが見つかりません' });
      // 旧管理者をstaffに
      const oldAdmin = members.find(m => m.deviceId === session.deviceId);
      if (oldAdmin) oldAdmin.role = 'staff';
      newAdmin.role = 'admin';
      data.admin = newAdmin.name;
      data.adminDeviceId = newAdmin.deviceId;
      await saveMembers(roomId, members);
      await saveRoomData(roomId, data);
      return res.status(200).json({ status: 'ok', newAdmin: newAdmin.name });
    }

    // === メンバー一覧 ===
    if (action === 'members' && req.method === 'GET') {
      const members = await getMembers(roomId);
      return res.status(200).json({ members, admin: data.admin });
    }

    // === メンバー削除（管理者のみ） ===
    if (action === 'member/remove' && req.method === 'POST') {
      if (!isAdmin) return res.status(403).json({ error: '管理者のみ実行できます' });
      let members = await getMembers(roomId);
      members = members.filter(m => m.deviceId !== body.deviceId);
      await saveMembers(roomId, members);
      return res.status(200).json({ status: 'ok' });
    }

    // === LINE設定（管理者のみ） ===
    if (action === 'line/config' && req.method === 'POST') {
      if (!isAdmin) return res.status(403).json({ error: '管理者のみ設定できます' });
      data.lineConfig = {
        channelAccessToken: (body.channelAccessToken || '').trim(),
        channelSecret: (body.channelSecret || '').trim(),
      };
      await saveRoomData(roomId, data);
      return res.status(200).json({ status: 'ok', webhookUrl: `https://${req.headers.host}/api/store/${roomId}/line/webhook` });
    }

    // === LINE設定取得 ===
    if (action === 'line/config' && req.method === 'GET') {
      if (!isAdmin) return res.status(403).json({ error: '管理者のみ閲覧できます' });
      return res.status(200).json({
        hasToken: !!(data.lineConfig?.channelAccessToken),
        webhookUrl: `https://${req.headers.host}/api/store/${roomId}/line/webhook`,
      });
    }

    // === LINE友だち一覧 ===
    if (action === 'line/friends' && req.method === 'GET') {
      const friends = await getLineFriends(roomId);
      return res.status(200).json({ friends });
    }

    // === LINE友だちリンク ===
    if (action === 'line/link' && req.method === 'POST') {
      const friends = await getLineFriends(roomId);
      const f = friends.find(f => f.userId === body.lineUserId);
      if (!f) return res.status(404).json({ error: 'LINE友だちが見つかりません' });
      f.linked = body.cid || '';
      await saveLineFriends(roomId, friends);
      return res.status(200).json({ status: 'ok' });
    }

    // === LINE一斉送信 ===
    if (action === 'line/send-broadcast' && req.method === 'POST') {
      const lineToken = data.lineConfig?.channelAccessToken;
      if (!lineToken) return res.status(400).json({ error: 'LINE未設定です' });
      const friends = await getLineFriends(roomId);
      if (!friends.length) return res.status(400).json({ error: 'LINE友だちがいません' });
      const msg = body.message || 'テストメッセージ';
      let sent = 0;
      for (const f of friends) {
        const r = await sendLineMessage(lineToken, f.userId, [{ type: 'text', text: msg }]);
        if (r.status === 'ok') sent++;
      }
      return res.status(200).json({ status: 'ok', sent });
    }

    // === LINE個別送信 ===
    if (action === 'line/send-individual' && req.method === 'POST') {
      const lineToken = data.lineConfig?.channelAccessToken;
      if (!lineToken) return res.status(400).json({ error: 'LINE未設定です' });
      const friends = await getLineFriends(roomId);
      const friend = friends.find(f => f.linked === body.cid);
      if (!friend) return res.status(400).json({ error: 'この顧客はLINEとリンクされていません' });
      const r = await sendLineMessage(lineToken, friend.userId, [{ type: 'text', text: body.message || '' }]);
      if (r.error) return res.status(500).json({ error: '送信失敗' });
      return res.status(200).json({ status: 'ok' });
    }

    // === LINE休眠リマインド ===
    if (action === 'line/send-dormant' && req.method === 'POST') {
      const lineToken = data.lineConfig?.channelAccessToken;
      if (!lineToken) return res.status(400).json({ error: 'LINE未設定です' });
      const friends = await getLineFriends(roomId);
      const now = Date.now();
      let sent = 0;
      for (const c of data.customers) {
        if (!c.lastVisit) continue;
        const diff = Math.floor((now - new Date(c.lastVisit).getTime()) / 864e5);
        if (diff < 90) continue;
        const friend = friends.find(f => f.linked === c.cid);
        if (!friend) continue;
        await sendLineMessage(lineToken, friend.userId, [{ type: 'text', text: `${c.name}様、ご無沙汰しております💆\n\n前回のご来店から${diff}日が経ちました。\nお身体のメンテナンスはいかがですか？\nぜひお気軽にご予約ください✨\n━━━━━━━━━━\n${data.name}` }]);
        sent++;
      }
      return res.status(200).json({ status: 'ok', sent });
    }

    // === LINE期限通知 ===
    if (action === 'line/send-expiry' && req.method === 'POST') {
      const lineToken = data.lineConfig?.channelAccessToken;
      if (!lineToken) return res.status(400).json({ error: 'LINE未設定です' });
      const friends = await getLineFriends(roomId);
      const settings = { ...DEFAULT_SETTINGS, ...data.settings };
      if (settings.expiryMonths <= 0) return res.status(400).json({ error: '有効期限が未設定です' });
      let sent = 0;
      for (const c of data.customers) {
        const friend = friends.find(f => f.linked === c.cid);
        if (!friend) continue;
        for (const t of c.tickets) {
          if (t.remaining <= 0) continue;
          const exp = new Date(t.purchasedAt); exp.setMonth(exp.getMonth() + settings.expiryMonths);
          const dl = Math.floor((exp - Date.now()) / 864e5);
          if (dl > 30 || dl < 0) continue;
          await sendLineMessage(lineToken, friend.userId, [{ type: 'text', text: `${c.name}様、回数券の期限が近づいています⏰\n\n${t.type}回券 あと${dl}日（残${t.remaining}回）\n期限前にぜひご利用ください💆\n━━━━━━━━━━\n${data.name}` }]);
          sent++; break;
        }
      }
      return res.status(200).json({ status: 'ok', sent });
    }

    // === データマイグレーション（既存B-careデータ取り込み） ===
    if (action === 'migrate' && req.method === 'POST') {
      if (!isAdmin) return res.status(403).json({ error: '管理者のみ実行できます' });
      // 旧データ(bcare:data)を読み込んでこのルームに取り込む
      const oldData = await redis.get('bcare:data');
      if (!oldData) return res.status(400).json({ error: '旧データが見つかりません' });
      const old = parseData(oldData);
      if (!old?.customers?.length) return res.status(400).json({ error: '旧データに顧客がいません' });
      let imported = 0;
      for (const c of old.customers) {
        if (data.customers.find(x => x.name === c.name)) continue;
        data.customers.push(c);
        imported++;
      }
      // 旧設定もマージ
      const oldSettings = await redis.get('bcare:settings');
      if (oldSettings) { data.settings = { ...data.settings, ...parseData(oldSettings) }; }
      // Vercel環境変数からLINEトークンを自動取り込み
      const envLineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
      const envLineSecret = process.env.LINE_CHANNEL_SECRET || '';
      if (envLineToken && !data.lineConfig?.channelAccessToken) {
        data.lineConfig = { channelAccessToken: envLineToken, channelSecret: envLineSecret };
      }
      await saveRoomData(roomId, data);
      // 旧LINE友だちデータも移行
      const oldFriends = await redis.get('bcare:line_friends');
      if (oldFriends) {
        const friends = parseData(oldFriends) || [];
        if (friends.length) await saveLineFriends(roomId, friends);
      }
      return res.status(200).json({ status: 'ok', imported, hasLine: !!(data.lineConfig?.channelAccessToken) });
    }

    return res.status(404).json({ error: 'Not found' });
  } catch (err) {
    console.error('API Error:', err);
    return res.status(500).json({ error: 'サーバーエラー' });
  }
};
