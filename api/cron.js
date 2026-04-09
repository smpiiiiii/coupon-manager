// 自動リマインドcronジョブ — 毎日朝9時(JST)に実行
// 予約前日リマインド、期限切れ通知、休眠リマインド、誕生月メッセージ
const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const ROOMS_INDEX = 'cp:rooms';

// データ解析ヘルパー
function parseData(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

// Redis操作
async function getRoomData(roomId) { return parseData(await redis.get(`cp:${roomId}:data`)); }
async function getLineFriends(roomId) { return parseData(await redis.get(`cp:${roomId}:line_friends`)) || []; }

// LINEメッセージ送信
async function sendLineMessage(token, userId, messages) {
  if (!token) return { error: 'LINE未設定' };
  try {
    const r = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ to: userId, messages }),
    });
    return r.ok ? { status: 'ok' } : { error: `LINE API ${r.status}` };
  } catch (e) { return { error: e.message }; }
}

module.exports = async (req, res) => {
  // Vercel Cronからの認証チェック
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}` && !process.env.CRON_SECRET_SKIP) {
    // CRON_SECRETが未設定の場合はスキップ（開発環境用）
    if (process.env.CRON_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    const now = new Date();
    // 日本時間で計算
    const jstOffset = 9 * 60 * 60 * 1000;
    const jstNow = new Date(now.getTime() + jstOffset);
    const today = jstNow.toISOString().split('T')[0];
    const currentMonth = jstNow.getMonth() + 1;

    // 明日の日付（予約リマインド用）
    const tomorrow = new Date(jstNow);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];

    // 全ルームを取得
    const roomIds = await redis.smembers(ROOMS_INDEX);
    if (!roomIds || !roomIds.length) {
      return res.status(200).json({ status: 'ok', message: 'ルームなし', sent: 0 });
    }

    let totalSent = 0;
    const log = [];

    for (const roomId of roomIds) {
      const data = await getRoomData(roomId);
      if (!data) continue;

      const lineToken = data.lineConfig?.channelAccessToken;
      if (!lineToken) continue;

      const friends = await getLineFriends(roomId);
      if (!friends.length) continue;

      const settings = data.settings || {};
      const storeName = data.name || '回数券管理';

      for (const friend of friends) {
        if (!friend.linked || !friend.userId) continue;
        const customer = data.customers.find(c => c.cid === friend.linked);
        if (!customer) continue;

        // ===== 1. 予約前日リマインド =====
        if (customer.nextAppointment === tomorrowStr) {
          const msg = `${customer.name}様\n\n📅 明日のご予約リマインドです！\n\n日時: ${tomorrowStr}\n\nお会いできるのを楽しみにしています😊\n━━━━━━━━━━\n${storeName}`;
          const r = await sendLineMessage(lineToken, friend.userId, [{ type: 'text', text: msg }]);
          if (r.status === 'ok') { totalSent++; log.push(`${roomId}:${customer.name}:予約リマインド`); }
        }

        // ===== 2. 回数券期限切れ7日前通知 =====
        if (settings.expiryMonths > 0) {
          for (const t of (customer.tickets || [])) {
            if (t.remaining <= 0) continue;
            const exp = new Date(t.purchasedAt);
            exp.setMonth(exp.getMonth() + settings.expiryMonths);
            const daysLeft = Math.floor((exp - jstNow) / 864e5);
            // 7日前ちょうどに通知（1日1回なので重複なし）
            if (daysLeft === 7) {
              const msg = `${customer.name}様\n\n⏰ 回数券の有効期限が近づいています\n\n🎫 ${t.type}回券 残${t.remaining}回\n📅 期限: あと${daysLeft}日\n\n期限前にぜひご利用ください💆\n━━━━━━━━━━\n${storeName}`;
              const r = await sendLineMessage(lineToken, friend.userId, [{ type: 'text', text: msg }]);
              if (r.status === 'ok') { totalSent++; log.push(`${roomId}:${customer.name}:期限通知`); }
              break; // 1人1通まで
            }
          }
        }

        // ===== 3. 休眠3ヶ月リマインド =====
        const lastVisit = customer.lastVisit || customer.tickets?.map(t =>
          t.usageLog?.map(l => typeof l === 'string' ? l : l.date).sort().pop()
        ).filter(Boolean).sort().pop();
        if (lastVisit) {
          const diffDays = Math.floor((jstNow - new Date(lastVisit)) / 864e5);
          // 90日目ちょうどに通知
          if (diffDays === 90) {
            const msg = `${customer.name}様\n\nお久しぶりです！🙏\n最後のご来店から3ヶ月が経ちました。\n\nお体の調子はいかがですか？\nまたお気軽にご予約ください😊\n━━━━━━━━━━\n${storeName}`;
            const r = await sendLineMessage(lineToken, friend.userId, [{ type: 'text', text: msg }]);
            if (r.status === 'ok') { totalSent++; log.push(`${roomId}:${customer.name}:休眠リマインド`); }
          }
        }

        // ===== 4. 誕生月メッセージ（月初1日のみ） =====
        if (jstNow.getDate() === 1 && customer.birthday) {
          const birthMonth = parseInt(customer.birthday.split('-')[1]);
          if (birthMonth === currentMonth) {
            const msg = `${customer.name}様\n\n🎂 お誕生日おめでとうございます！\n\n素敵な一年をお過ごしください✨\nスタッフ一同、心よりお祝い申し上げます🎉\n━━━━━━━━━━\n${storeName}`;
            const r = await sendLineMessage(lineToken, friend.userId, [{ type: 'text', text: msg }]);
            if (r.status === 'ok') { totalSent++; log.push(`${roomId}:${customer.name}:誕生日`); }
          }
        }
      }
    }

    console.log(`[CRON] ${today} 送信完了: ${totalSent}件`, log);
    return res.status(200).json({ status: 'ok', date: today, sent: totalSent, log });
  } catch (err) {
    console.error('[CRON] Error:', err);
    return res.status(500).json({ error: err.message });
  }
};
