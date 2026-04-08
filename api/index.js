// B-care 回数券管理アプリ — Vercel サーバーレスAPI v2
// 全機能実装: 売上レポート, 予約メモ, 金額管理, 施術メモ, 有効期限, CSVエクスポート, 誕生日, スタッフ管理
const { Redis } = require('@upstash/redis');
const crypto = require('crypto');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const DEFAULT_PASSCODE = process.env.BCARE_PASSCODE || 'Bcare';
const PASSCODE_KEY = 'bcare:passcode';
const DATA_KEY = 'bcare:data';
const SETTINGS_KEY = 'bcare:settings';
const SESSION_PREFIX = 'bcare:session:';

// デフォルト設定
const DEFAULT_SETTINGS = {
  ticketPrices: { '4': 20000, '8': 36000, '16': 64000, '24': 84000, '48': 144000 },
  expiryMonths: 12,
  staffList: [],
};

async function getPasscode() {
  const saved = await redis.get(PASSCODE_KEY);
  return saved || DEFAULT_PASSCODE;
}
async function getData() {
  const data = await redis.get(DATA_KEY);
  if (!data) return { customers: [] };
  if (typeof data === 'string') return JSON.parse(data);
  return data;
}
async function saveData(data) {
  await redis.set(DATA_KEY, JSON.stringify(data));
}
async function getSettings() {
  const s = await redis.get(SETTINGS_KEY);
  if (!s) return { ...DEFAULT_SETTINGS };
  if (typeof s === 'string') return { ...DEFAULT_SETTINGS, ...JSON.parse(s) };
  return { ...DEFAULT_SETTINGS, ...s };
}
async function saveSettings(s) {
  await redis.set(SETTINGS_KEY, JSON.stringify(s));
}
async function validateSession(req) {
  const token = req.headers['x-auth-token'] || '';
  if (!token) return false;
  const valid = await redis.get(`${SESSION_PREFIX}${token}`);
  return !!valid;
}

// 利用ログを正規化（旧形式の文字列対応）
function normalizeLog(entry) {
  if (typeof entry === 'string') return { date: entry, memo: '', staff: '' };
  return entry;
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
    // === ログイン ===
    if (pathname === '/api/login' && req.method === 'POST') {
      const currentPasscode = await getPasscode();
      if ((body.passcode || '') !== currentPasscode) {
        return res.status(401).json({ error: 'パスコードが違います' });
      }
      const token = crypto.randomBytes(16).toString('hex');
      await redis.set(`${SESSION_PREFIX}${token}`, '1', { ex: 60 * 60 * 24 * 90 });
      return res.status(200).json({ token });
    }

    // === セッション確認 ===
    if (pathname === '/api/verify' && req.method === 'GET') {
      return res.status(200).json({ valid: await validateSession(req) });
    }

    // 認証チェック
    if (!(await validateSession(req))) {
      return res.status(401).json({ error: 'ログインが必要です' });
    }

    // === 全データ取得 ===
    if (pathname === '/api/data' && req.method === 'GET') {
      const data = await getData();
      const settings = await getSettings();
      const now = Date.now();
      const today = new Date().toISOString().split('T')[0];
      const thisMonth = today.slice(5, 7);
      const alerts = { month1: [], month3: [], month6: [], expiring: [], todayAppt: [], birthdayMonth: [] };

      for (const c of data.customers) {
        // 休眠アラート
        if (c.lastVisit) {
          const diffDays = Math.floor((now - new Date(c.lastVisit).getTime()) / 86400000);
          c._diffDays = diffDays;
          if (diffDays >= 180) alerts.month6.push(c);
          else if (diffDays >= 90) alerts.month3.push(c);
          else if (diffDays >= 30) alerts.month1.push(c);
        }
        // 今日の予約
        if (c.nextAppointment === today) alerts.todayAppt.push(c);
        // 誕生月
        if (c.birthday) {
          const bMonth = c.birthday.slice(5, 7);
          if (bMonth === thisMonth) alerts.birthdayMonth.push(c);
        }
        // 回数券有効期限チェック
        if (settings.expiryMonths > 0) {
          for (const t of c.tickets) {
            if (t.remaining <= 0) continue;
            const purchased = new Date(t.purchasedAt);
            const expiry = new Date(purchased);
            expiry.setMonth(expiry.getMonth() + settings.expiryMonths);
            const daysLeft = Math.floor((expiry.getTime() - now) / 86400000);
            if (daysLeft <= 30 && daysLeft > 0) {
              alerts.expiring.push({ ...c, _ticketTid: t.tid, _ticketType: t.type, _daysLeft: daysLeft });
            } else if (daysLeft <= 0) {
              t._expired = true;
            }
          }
        }
      }
      return res.status(200).json({ ...data, alerts, settings });
    }

    // === 設定取得 ===
    if (pathname === '/api/settings' && req.method === 'GET') {
      return res.status(200).json(await getSettings());
    }

    // === 設定更新 ===
    if (pathname === '/api/settings' && req.method === 'POST') {
      const current = await getSettings();
      if (body.ticketPrices) current.ticketPrices = body.ticketPrices;
      if (body.expiryMonths !== undefined) current.expiryMonths = parseInt(body.expiryMonths) || 0;
      if (body.staffList) current.staffList = body.staffList;
      await saveSettings(current);
      return res.status(200).json({ status: 'ok' });
    }

    // === 顧客追加 ===
    if (pathname === '/api/customer' && req.method === 'POST') {
      const data = await getData();
      const customer = {
        cid: crypto.randomBytes(4).toString('hex'),
        name: (body.name || '').trim(),
        phone: (body.phone || '').trim(),
        memo: (body.memo || '').trim(),
        birthday: (body.birthday || '').trim(),
        nextAppointment: (body.nextAppointment || '').trim(),
        tickets: [],
        lastVisit: null,
        createdAt: new Date().toISOString(),
      };
      if (!customer.name) return res.status(400).json({ error: 'お名前は必須です' });
      data.customers.push(customer);
      await saveData(data);
      return res.status(200).json({ status: 'ok', customer });
    }

    // === 顧客更新 ===
    if (pathname === '/api/customer/update' && req.method === 'POST') {
      const data = await getData();
      const c = data.customers.find(c => c.cid === body.cid);
      if (!c) return res.status(404).json({ error: '顧客が見つかりません' });
      if (body.name !== undefined) c.name = (body.name || '').trim();
      if (body.phone !== undefined) c.phone = (body.phone || '').trim();
      if (body.memo !== undefined) c.memo = (body.memo || '').trim();
      if (body.birthday !== undefined) c.birthday = (body.birthday || '').trim();
      if (body.nextAppointment !== undefined) c.nextAppointment = (body.nextAppointment || '').trim();
      await saveData(data);
      return res.status(200).json({ status: 'ok' });
    }

    // === 顧客削除 ===
    if (pathname === '/api/customer/delete' && req.method === 'POST') {
      const data = await getData();
      const idx = data.customers.findIndex(c => c.cid === body.cid);
      if (idx === -1) return res.status(404).json({ error: '顧客が見つかりません' });
      data.customers.splice(idx, 1);
      await saveData(data);
      return res.status(200).json({ status: 'ok' });
    }

    // === 回数券追加 ===
    if (pathname === '/api/ticket' && req.method === 'POST') {
      const data = await getData();
      const c = data.customers.find(c => c.cid === body.cid);
      if (!c) return res.status(404).json({ error: '顧客が見つかりません' });
      const type = parseInt(body.type);
      if (![4, 8, 16, 24, 48].includes(type)) return res.status(400).json({ error: '不正な券種' });
      c.tickets.push({
        tid: crypto.randomBytes(4).toString('hex'),
        type, remaining: type,
        purchasedAt: new Date().toISOString().split('T')[0],
        usageLog: [],
      });
      await saveData(data);
      return res.status(200).json({ status: 'ok' });
    }

    // === 回数券利用（施術メモ・スタッフ付き） ===
    if (pathname === '/api/use' && req.method === 'POST') {
      const data = await getData();
      const c = data.customers.find(c => c.cid === body.cid);
      if (!c) return res.status(404).json({ error: '顧客が見つかりません' });
      const t = c.tickets.find(t => t.tid === body.tid);
      if (!t) return res.status(404).json({ error: '回数券が見つかりません' });
      if (t.remaining <= 0) return res.status(400).json({ error: '残りがありません' });
      t.remaining--;
      const today = new Date().toISOString().split('T')[0];
      t.usageLog.push({
        date: today,
        memo: (body.treatmentMemo || '').trim(),
        staff: (body.staff || '').trim(),
      });
      c.lastVisit = today;
      await saveData(data);
      return res.status(200).json({ status: 'ok', remaining: t.remaining });
    }

    // === 回数券削除 ===
    if (pathname === '/api/ticket/delete' && req.method === 'POST') {
      const data = await getData();
      const c = data.customers.find(c => c.cid === body.cid);
      if (!c) return res.status(404).json({ error: '顧客が見つかりません' });
      const idx = c.tickets.findIndex(t => t.tid === body.tid);
      if (idx === -1) return res.status(404).json({ error: '回数券が見つかりません' });
      c.tickets.splice(idx, 1);
      await saveData(data);
      return res.status(200).json({ status: 'ok' });
    }

    // === 売上レポート ===
    if (pathname === '/api/report' && req.method === 'GET') {
      const data = await getData();
      const settings = await getSettings();
      const monthly = {};
      for (const c of data.customers) {
        for (const t of c.tickets) {
          // 販売集計
          const pMonth = t.purchasedAt.slice(0, 7);
          if (!monthly[pMonth]) monthly[pMonth] = { purchased: 0, used: 0, revenue: 0, staffCount: {} };
          monthly[pMonth].purchased++;
          monthly[pMonth].revenue += (settings.ticketPrices[String(t.type)] || 0);
          // 消化集計
          for (const log of t.usageLog) {
            const entry = normalizeLog(log);
            const uMonth = entry.date.slice(0, 7);
            if (!monthly[uMonth]) monthly[uMonth] = { purchased: 0, used: 0, revenue: 0, staffCount: {} };
            monthly[uMonth].used++;
            if (entry.staff) {
              monthly[uMonth].staffCount[entry.staff] = (monthly[uMonth].staffCount[entry.staff] || 0) + 1;
            }
          }
        }
      }
      return res.status(200).json({ monthly });
    }

    // === CSVエクスポート ===
    if (pathname === '/api/export' && req.method === 'GET') {
      const data = await getData();
      const type = url.searchParams.get('type') || 'customers';
      let csv = '';
      if (type === 'customers') {
        csv = '名前,電話番号,メモ,誕生日,最終来店日,有効回数券数,次回予約\n';
        for (const c of data.customers) {
          const active = c.tickets.filter(t => t.remaining > 0).length;
          csv += `"${c.name}","${c.phone || ''}","${c.memo || ''}","${c.birthday || ''}","${c.lastVisit || ''}",${active},"${c.nextAppointment || ''}"\n`;
        }
      } else if (type === 'visits') {
        csv = '顧客名,日付,施術メモ,担当スタッフ,券種\n';
        for (const c of data.customers) {
          for (const t of c.tickets) {
            for (const log of t.usageLog) {
              const entry = normalizeLog(log);
              csv += `"${c.name}","${entry.date}","${entry.memo || ''}","${entry.staff || ''}",${t.type}回券\n`;
            }
          }
        }
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${type}_${new Date().toISOString().split('T')[0]}.csv"`);
      return res.status(200).send('\uFEFF' + csv);
    }

    // === CSV一括インポート ===
    if (pathname === '/api/bulk-import' && req.method === 'POST') {
      const data = await getData();
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
          tickets: [], lastVisit: null, createdAt: new Date().toISOString(),
        };
        data.customers.push(customer);
        added.push(customer);
      }
      await saveData(data);
      return res.status(200).json({ status: 'ok', added: added.length, errors });
    }

    // === 顧客一括削除（全件 or 選択） ===
    if (pathname === '/api/customer/bulk-delete' && req.method === 'POST') {
      const data = await getData();
      const cids = body.cids || []; // 空配列なら全件削除
      if (cids.length === 0) {
        // 全件削除
        const count = data.customers.length;
        data.customers = [];
        await saveData(data);
        return res.status(200).json({ status: 'ok', deleted: count });
      }
      // 選択削除
      const before = data.customers.length;
      data.customers = data.customers.filter(c => !cids.includes(c.cid));
      const deleted = before - data.customers.length;
      await saveData(data);
      return res.status(200).json({ status: 'ok', deleted });
    }

    // === パスコード変更 ===
    if (pathname === '/api/change-passcode' && req.method === 'POST') {
      const currentPasscode = await getPasscode();
      if (body.current !== currentPasscode) return res.status(400).json({ error: '現在のパスコードが違います' });
      const newPass = (body.newPasscode || '').trim();
      if (!newPass || newPass.length < 2) return res.status(400).json({ error: '2文字以上' });
      await redis.set(PASSCODE_KEY, newPass);
      return res.status(200).json({ status: 'ok' });
    }

    return res.status(404).json({ error: 'Not found' });
  } catch (err) {
    console.error('API Error:', err);
    return res.status(500).json({ error: 'サーバーエラー' });
  }
};
