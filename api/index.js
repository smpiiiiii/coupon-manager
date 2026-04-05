// B-care 回数券管理アプリ — Vercel サーバーレスAPI
// Upstash Redis でデータ永続化（薬剤管理とインスタンス共有、プレフィックスで分離）
const { Redis } = require('@upstash/redis');
const crypto = require('crypto');

// Upstash Redis クライアント
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const DATA_KEY = 'bcare:data';

// データの読み書き
async function getData() {
  const data = await redis.get(DATA_KEY);
  if (!data) return { customers: [] };
  if (typeof data === 'string') return JSON.parse(data);
  return data;
}
async function saveData(data) {
  await redis.set(DATA_KEY, JSON.stringify(data));
}

module.exports = async (req, res) => {
  // CORS対応
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const url = new URL(req.url, `https://${req.headers.host}`);
  const pathname = url.pathname;
  const body = req.body || {};

  try {
    // === 全データ取得 ===
    if (pathname === '/api/data' && req.method === 'GET') {
      const data = await getData();
      // 休眠アラート計算
      const now = Date.now();
      const alerts = { month1: [], month3: [], month6: [] };
      for (const c of data.customers) {
        if (!c.lastVisit) continue;
        const lastVisitMs = new Date(c.lastVisit).getTime();
        const diffDays = Math.floor((now - lastVisitMs) / (1000 * 60 * 60 * 24));
        c._diffDays = diffDays;
        if (diffDays >= 180) alerts.month6.push(c);
        else if (diffDays >= 90) alerts.month3.push(c);
        else if (diffDays >= 30) alerts.month1.push(c);
      }
      return res.status(200).json({ ...data, alerts });
    }

    // === 顧客追加 ===
    if (pathname === '/api/customer' && req.method === 'POST') {
      const data = await getData();
      const customer = {
        cid: crypto.randomBytes(4).toString('hex'),
        name: (body.name || '').trim(),
        phone: (body.phone || '').trim(),
        memo: (body.memo || '').trim(),
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
      if (![4, 8, 16, 24, 48].includes(type)) {
        return res.status(400).json({ error: '回数券の種類が不正です' });
      }
      const ticket = {
        tid: crypto.randomBytes(4).toString('hex'),
        type,
        remaining: type,
        purchasedAt: new Date().toISOString().split('T')[0],
        usageLog: [],
      };
      c.tickets.push(ticket);
      await saveData(data);
      return res.status(200).json({ status: 'ok', ticket });
    }

    // === 回数券利用（1回消化） ===
    if (pathname === '/api/use' && req.method === 'POST') {
      const data = await getData();
      const c = data.customers.find(c => c.cid === body.cid);
      if (!c) return res.status(404).json({ error: '顧客が見つかりません' });
      const t = c.tickets.find(t => t.tid === body.tid);
      if (!t) return res.status(404).json({ error: '回数券が見つかりません' });
      if (t.remaining <= 0) return res.status(400).json({ error: '回数券の残りがありません' });

      t.remaining--;
      const today = new Date().toISOString().split('T')[0];
      t.usageLog.push(today);
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

    return res.status(404).json({ error: 'Not found' });
  } catch (err) {
    console.error('API Error:', err);
    return res.status(500).json({ error: 'サーバーエラー' });
  }
};
