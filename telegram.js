const TelegramBot = require('node-telegram-bot-api');
const { db, getSettings } = require('./database');

let bot = null;

function initBot() {
  const settings = getSettings();
  const token = settings.telegram_bot_token;

  // Eski botu kapat
  if (bot) {
    try { bot.stopPolling(); } catch (e) {}
    bot = null;
  }

  if (!token) return;

  try {
    bot = new TelegramBot(token, { polling: true });

    bot.on('polling_error', (err) => {
      console.error('[Telegram] Polling error:', err.message);
    });

    // Callback query handler (inline buton tıklamaları)
    bot.on('callback_query', async (query) => {
      const data = query.data;
      const chatId = query.message.chat.id;
      const messageId = query.message.message_id;

      try {
        if (data.startsWith('approve_')) {
          const orderId = parseInt(data.replace('approve_', ''));
          const oldOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
          db.prepare("UPDATE orders SET status = 'processing' WHERE id = ?").run(orderId);
          const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);

          // EFT siparis onaylandiginda Meta Purchase event tetikle
          if (oldOrder && oldOrder.payment_method === 'eft' && oldOrder.status === 'pending_payment') {
            try {
              const { triggerPurchaseForOrder } = require('./meta-capi');
              triggerPurchaseForOrder(orderId);
            } catch (e) { console.error('[CAPI] Telegram purchase trigger:', e.message); }
          }
          const name = order.guest_name || order.user_id || '-';

          bot.editMessageText(
            `✅ *SİPARİŞ ONAYLANDI*\n\n` +
            `Sipariş *#${orderId}* onaylandı.\n` +
            `👤 ${name}\n` +
            `💰 ${order.total.toLocaleString('tr-TR')} ₺\n\n` +
            `Müşteriye ödeme onayı iletildi.`,
            {
              chat_id: chatId,
              message_id: messageId,
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [[
                  { text: '🚚 Kargoya Ver', callback_data: `ship_${orderId}` },
                  { text: '📋 Detay', callback_data: `detail_${orderId}` }
                ]]
              }
            }
          );
          bot.answerCallbackQuery(query.id, { text: '✅ Sipariş onaylandı!' });

        } else if (data.startsWith('reject_')) {
          const orderId = parseInt(data.replace('reject_', ''));
          db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(orderId);

          bot.editMessageText(
            `❌ *SİPARİŞ İPTAL EDİLDİ*\n\nSipariş *#${orderId}* iptal edildi.`,
            {
              chat_id: chatId,
              message_id: messageId,
              parse_mode: 'Markdown',
              reply_markup: { inline_keyboard: [] }
            }
          );
          bot.answerCallbackQuery(query.id, { text: '❌ Sipariş iptal edildi.' });

        } else if (data.startsWith('ship_')) {
          const orderId = parseInt(data.replace('ship_', ''));
          db.prepare("UPDATE orders SET status = 'shipped' WHERE id = ?").run(orderId);

          bot.editMessageText(
            `🚚 *KARGOYA VERİLDİ*\n\nSipariş *#${orderId}* kargoya verildi.`,
            {
              chat_id: chatId,
              message_id: messageId,
              parse_mode: 'Markdown',
              reply_markup: { inline_keyboard: [] }
            }
          );
          bot.answerCallbackQuery(query.id, { text: '🚚 Kargoya verildi!' });

        } else if (data.startsWith('detail_')) {
          const orderId = parseInt(data.replace('detail_', ''));
          const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
          if (!order) {
            bot.answerCallbackQuery(query.id, { text: 'Sipariş bulunamadı.' });
            return;
          }
          const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);

          const statusLabels = {
            pending_payment: '⏳ Ödeme Bekleniyor',
            pending: '🕐 Beklemede',
            processing: '✅ Onaylandı',
            shipped: '🚚 Kargoda',
            delivered: '📦 Teslim Edildi',
            cancelled: '❌ İptal'
          };

          let msg = `📋 *SİPARİŞ DETAY #${orderId}*\n\n`;
          msg += `📊 Durum: ${statusLabels[order.status] || order.status}\n`;
          msg += `👤 ${order.guest_name || '-'}\n`;
          msg += `📞 ${order.guest_phone || '-'}\n`;
          msg += `📧 ${order.guest_email || '-'}\n\n`;
          msg += `📍 *Adres:*\n${order.address}\n${order.district ? order.district + ', ' : ''}${order.city}\n\n`;
          msg += `📦 *Ürünler:*\n`;
          items.forEach(item => {
            let line = `  • ${item.product_name}`;
            if (item.size) line += ` (${item.size})`;
            if (item.color) line += ` - ${item.color}`;
            line += ` x${item.quantity} — ${(item.price * item.quantity).toLocaleString('tr-TR')} ₺`;
            msg += line + '\n';
          });
          msg += `\n💰 Toplam: *${order.total.toLocaleString('tr-TR')} ₺*`;
          if (order.note) msg += `\n📝 Not: ${order.note}`;

          bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
          bot.answerCallbackQuery(query.id);
        }
      } catch (err) {
        console.error('[Telegram] Callback error:', err.message);
        bot.answerCallbackQuery(query.id, { text: 'Hata oluştu.' });
      }
    });

    // /start komutu
    bot.onText(/\/start/, (msg) => {
      bot.sendMessage(msg.chat.id,
        `🤖 *Mağaza Sipariş Botu*\n\n` +
        `Bu bot yeni siparişleri bildirir ve sipariş yönetimi sağlar.\n\n` +
        `📌 Chat ID'niz: \`${msg.chat.id}\`\n\n` +
        `Bu ID'yi admin panelindeki ayarlara girin.`,
        { parse_mode: 'Markdown' }
      );
    });

    console.log('[Telegram] Bot başlatıldı.');
  } catch (err) {
    console.error('[Telegram] Bot başlatma hatası:', err.message);
  }
}

function sendOrderNotification(orderId) {
  const settings = getSettings();
  const chatId = settings.telegram_chat_id;
  if (!bot || !chatId) return;

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return;

  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);

  const paymentLabels = { eft: 'EFT / Havale / FAST', cod: 'Kapıda Ödeme' };
  const freeLimit = parseFloat(settings.free_shipping_limit) || 2000;

  let msg = `🛒 *YENİ SİPARİŞ #${orderId}*\n\n`;
  msg += `👤 ${order.guest_name || '-'}\n`;
  msg += `📞 ${order.guest_phone || '-'}\n`;
  msg += `📧 ${order.guest_email || '-'}\n\n`;
  msg += `📦 *Ürünler:*\n`;
  items.forEach(item => {
    let line = `  • ${item.product_name}`;
    if (item.size) line += ` (${item.size})`;
    if (item.color) line += ` - ${item.color}`;
    line += ` x${item.quantity} — ${(item.price * item.quantity).toLocaleString('tr-TR')} ₺`;
    msg += line + '\n';
  });
  msg += `\n💰 Toplam: *${order.total.toLocaleString('tr-TR')} ₺*\n`;
  msg += `🚚 Kargo: ${order.shipping > 0 ? order.shipping.toLocaleString('tr-TR') + ' ₺' : 'Ücretsiz'}\n`;
  msg += `💳 Ödeme: ${paymentLabels[order.payment_method] || order.payment_method}\n\n`;
  msg += `📍 ${order.city}${order.district ? ', ' + order.district : ''}\n`;
  msg += `${order.address}`;
  if (order.note) msg += `\n\n📝 *Not:* ${order.note}`;

  const keyboard = {
    inline_keyboard: [[
      { text: '✅ Onayla', callback_data: `approve_${orderId}` },
      { text: '❌ İptal', callback_data: `reject_${orderId}` },
      { text: '📋 Detay', callback_data: `detail_${orderId}` }
    ]]
  };

  bot.sendMessage(chatId, msg, {
    parse_mode: 'Markdown',
    reply_markup: keyboard
  }).catch(err => {
    console.error('[Telegram] Mesaj gönderme hatası:', err.message);
  });
}

function sendPaymentClaimNotification(orderId) {
  const settings = getSettings();
  const chatId = settings.telegram_chat_id;
  if (!bot || !chatId) return;

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return;

  const msg =
    `💰 *ODEME BILDIRIMI*\n\n` +
    `Musteri siparis *#${orderId}* icin odeme yaptigini bildirdi!\n\n` +
    `👤 ${order.guest_name || '-'}\n` +
    `📞 ${order.guest_phone || '-'}\n` +
    `💰 ${order.total?.toLocaleString('tr-TR')} TL\n\n` +
    `Lutfen banka hesabinizi kontrol edin.`;

  bot.sendMessage(chatId, msg, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Onayla', callback_data: `approve_${orderId}` },
        { text: '📋 Detay', callback_data: `detail_${orderId}` }
      ]]
    }
  }).catch(err => {
    console.error('[Telegram] Odeme bildirim hatasi:', err.message);
  });
}

module.exports = { initBot, sendOrderNotification, sendPaymentClaimNotification };
