/**
 * WhatsApp Hatirlatma Sistemi (API'siz)
 *
 * - Havale/EFT yapmayanlar ve terk edilen sepetleri otomatik tespit eder
 * - Admin panelde tek tikla wa.me linki ile WhatsApp acar (mesaj hazir)
 * - Telegram bot'a bildirim gonderir: "Su kisi odeme yapmadi"
 * - API gerektirmez, tamamen sunucu tarafli takip + wa.me link
 */
const { db, getSettings } = require('./database');

let checkInterval = null;

// ============ TELEFON DUZELTME ============

function cleanPhone(phone) {
  if (!phone) return '';
  let p = phone.replace(/[\s\-\(\)]/g, '');
  if (p.startsWith('+')) p = p.substring(1);
  if (p.startsWith('0')) p = '90' + p.substring(1);
  if (!p.startsWith('90')) p = '90' + p;
  return p;
}

function waLink(phone, message) {
  const p = cleanPhone(phone);
  return `https://wa.me/${p}?text=${encodeURIComponent(message)}`;
}

// ============ MESAJ SABLONU ============

function fillTemplate(template, vars) {
  let msg = template;
  for (const [key, val] of Object.entries(vars)) {
    msg = msg.replace(new RegExp(`\\{${key}\\}`, 'g'), val || '');
  }
  return msg;
}

// ============ LOG ============

function logWA(phone, messageType, orderId, message, status) {
  try {
    db.prepare(
      `INSERT INTO whatsapp_logs (phone, message_type, order_id, template, status, sent_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`
    ).run(phone, messageType, orderId || null, message, status);
  } catch (e) {}
}

// ============ BEKLEYEN HATIRLATMALARI BUL ============

/**
 * Odeme yapmamis siparisleri bul
 */
function getPendingPaymentOrders() {
  const settings = getSettings();
  const delayMinutes = parseInt(settings.wa_payment_reminder_delay) || 60;

  return db.prepare(`
    SELECT o.*,
      (SELECT COUNT(*) FROM whatsapp_logs WHERE order_id = o.id AND message_type = 'payment_reminder' AND status = 'sent') as wa_sent_count,
      (SELECT MAX(sent_at) FROM whatsapp_logs WHERE order_id = o.id AND message_type = 'payment_reminder') as last_wa_sent
    FROM orders o
    WHERE o.payment_method = 'eft'
    AND o.status = 'pending_payment'
    AND o.guest_phone IS NOT NULL AND o.guest_phone != ''
    AND o.created_at <= datetime('now', '-${delayMinutes} minutes')
    ORDER BY o.created_at ASC
  `).all();
}

/**
 * Terk edilen sepetleri bul (telefonu olan)
 */
function getAbandonedCarts() {
  const settings = getSettings();
  const delayMinutes = parseInt(settings.wa_abandoned_cart_delay) || 30;

  return db.prepare(`
    SELECT ac.*,
      (SELECT COUNT(*) FROM whatsapp_logs WHERE phone = ac.phone AND message_type = 'abandoned_cart' AND status = 'sent' AND created_at > datetime('now', '-24 hours')) as wa_sent_count
    FROM abandoned_cart_logs ac
    WHERE ac.phone IS NOT NULL AND ac.phone != ''
    AND ac.recovered = 0
    AND ac.email_sent = 0
    AND ac.created_at <= datetime('now', '-${delayMinutes} minutes')
    AND ac.created_at >= datetime('now', '-7 days')
    ORDER BY ac.created_at DESC
  `).all();
}

/**
 * Odeme hatirlatma mesaji olustur
 */
function buildPaymentMessage(order) {
  const settings = getSettings();
  const template = settings.wa_payment_reminder_message ||
    'Merhaba {name}, #{order_id} numarali siparisiniz icin odeme bekleniyor. Toplam: {total} TL.\n\nOdeme sayfasi: {payment_link}\n\nIBAN: {iban}';

  const paymentLink = order.payment_token
    ? `https://modaflavora.com/odeme-hatirlatma/${order.payment_token}`
    : '';

  return fillTemplate(template, {
    name: order.guest_name || '',
    order_id: String(order.id),
    total: order.total?.toLocaleString('tr-TR') || '0',
    iban: settings.bank_iban || '',
    bank_name: settings.bank_name || '',
    bank_holder: settings.bank_holder || '',
    payment_link: paymentLink
  });
}

/**
 * Terk edilen sepet mesaji olustur
 */
function buildAbandonedMessage(cart) {
  const settings = getSettings();
  const template = settings.wa_abandoned_cart_message ||
    'Merhaba {name}, sepetinizde {count} urun kaldi. Siparisinizi tamamlayin: {site_url}';

  let cartData;
  try { cartData = JSON.parse(cart.cart_data || '[]'); } catch (e) { cartData = []; }

  return fillTemplate(template, {
    name: cart.guest_name || '',
    count: String(cartData.length),
    total: cart.cart_total?.toLocaleString('tr-TR') || '0',
    site_url: 'https://modaflavora.com'
  });
}

// ============ TELEGRAM BILDIRIM ============

/**
 * Telegram'a odeme hatirlatma bildirimi gonder
 */
function sendTelegramReminder(order) {
  try {
    const TelegramBot = require('node-telegram-bot-api');
    const settings = getSettings();
    const token = settings.telegram_bot_token;
    const chatId = settings.telegram_chat_id;
    if (!token || !chatId) return;

    const bot = new TelegramBot(token);
    const waMsg = buildPaymentMessage(order);
    const waUrl = waLink(order.guest_phone, waMsg);
    const hours = Math.round((Date.now() - new Date(order.created_at + 'Z').getTime()) / (1000 * 60 * 60));

    const msg =
      `⏰ *ODEME HATIRLATMA*\n\n` +
      `Siparis *#${order.id}* - ${hours} saat oldu, odeme yapilmadi!\n\n` +
      `👤 ${order.guest_name || '-'}\n` +
      `📞 ${order.guest_phone}\n` +
      `💰 ${order.total?.toLocaleString('tr-TR')} TL\n\n` +
      `[📱 WhatsApp ile Hatirlatma Gonder](${waUrl})`;

    bot.sendMessage(chatId, msg, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[
          { text: '📱 WhatsApp Gonder', url: waUrl },
          { text: '✅ Odeme Alindi', callback_data: `approve_${order.id}` }
        ]]
      }
    }).catch(err => {
      console.error('[WhatsApp-TG] Bildirim hatasi:', err.message);
    });
  } catch (e) {
    console.error('[WhatsApp-TG] Hata:', e.message);
  }
}

/**
 * Telegram'a terk edilen sepet bildirimi gonder
 */
function sendTelegramCartReminder(cart) {
  try {
    const TelegramBot = require('node-telegram-bot-api');
    const settings = getSettings();
    const token = settings.telegram_bot_token;
    const chatId = settings.telegram_chat_id;
    if (!token || !chatId) return;

    const bot = new TelegramBot(token);
    const waMsg = buildAbandonedMessage(cart);
    const waUrl = waLink(cart.phone, waMsg);

    let cartData;
    try { cartData = JSON.parse(cart.cart_data || '[]'); } catch (e) { cartData = []; }

    let itemList = cartData.slice(0, 3).map(i => `  • ${i.name} x${i.quantity}`).join('\n');
    if (cartData.length > 3) itemList += `\n  ... +${cartData.length - 3} urun daha`;

    const msg =
      `🛒 *TERK EDILEN SEPET*\n\n` +
      `👤 ${cart.guest_name || '-'}\n` +
      `📞 ${cart.phone}\n` +
      `💰 ${cart.cart_total?.toLocaleString('tr-TR')} TL\n\n` +
      `📦 Urunler:\n${itemList}\n\n` +
      `[📱 WhatsApp ile Hatirlatma Gonder](${waUrl})`;

    bot.sendMessage(chatId, msg, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[
          { text: '📱 WhatsApp Gonder', url: waUrl }
        ]]
      }
    }).catch(err => {
      console.error('[WhatsApp-TG] Cart bildirim hatasi:', err.message);
    });
  } catch (e) {}
}

// ============ PERIYODIK KONTROL ============

function checkAndNotify() {
  const settings = getSettings();
  if (settings.wa_enabled !== '1') return;

  // Odeme hatirlatma
  if (settings.wa_payment_reminder_enabled === '1') {
    const orders = getPendingPaymentOrders();
    for (const order of orders) {
      if (order.wa_sent_count === 0) {
        // Henuz bildirim gonderilmemis - Telegram'a bildir
        sendTelegramReminder(order);
        logWA(order.guest_phone, 'payment_reminder', order.id, 'telegram_notified', 'sent');
      }
    }
  }

  // Terk edilen sepet
  if (settings.wa_abandoned_cart_enabled === '1') {
    const carts = getAbandonedCarts();
    for (const cart of carts) {
      if (cart.wa_sent_count === 0) {
        sendTelegramCartReminder(cart);
        logWA(cart.phone, 'abandoned_cart', null, 'telegram_notified', 'sent');
      }
    }
  }
}

function startWhatsAppChecker() {
  if (checkInterval) { clearInterval(checkInterval); checkInterval = null; }

  const settings = getSettings();
  if (settings.wa_enabled !== '1') {
    console.log('[WhatsApp] Sistem kapali.');
    return;
  }

  // Her 5 dk kontrol et
  checkInterval = setInterval(() => {
    try { checkAndNotify(); } catch (e) {
      console.error('[WhatsApp] Kontrol hatasi:', e.message);
    }
  }, 5 * 60 * 1000);

  // Ilk calistirmada 15sn sonra kontrol
  setTimeout(() => { try { checkAndNotify(); } catch (e) {} }, 15000);

  console.log('[WhatsApp] Hatirlatma sistemi baslatildi.');
}

function stopWhatsAppChecker() {
  if (checkInterval) { clearInterval(checkInterval); checkInterval = null; }
}

// ============ INIT ============

function initWhatsApp() {
  startWhatsAppChecker();
}

function stopWhatsApp() {
  stopWhatsAppChecker();
}

// ============ ADMIN PANEL ICIN ============

/**
 * Admin panelde gosterilecek bekleyen hatirlatmalar
 */
function getDashboardData() {
  const settings = getSettings();

  const pendingPayments = getPendingPaymentOrders();
  const abandonedCarts = getAbandonedCarts().filter(c => c.wa_sent_count === 0);

  // Her siparis icin wa.me linki olustur
  const paymentReminders = pendingPayments.map(order => ({
    ...order,
    waMessage: buildPaymentMessage(order),
    waLink: waLink(order.guest_phone, buildPaymentMessage(order)),
    hoursAgo: Math.round((Date.now() - new Date(order.created_at + 'Z').getTime()) / (1000 * 60 * 60))
  }));

  const cartReminders = abandonedCarts.map(cart => {
    let cartData;
    try { cartData = JSON.parse(cart.cart_data || '[]'); } catch (e) { cartData = []; }
    return {
      ...cart,
      cartItems: cartData,
      waMessage: buildAbandonedMessage(cart),
      waLink: waLink(cart.phone, buildAbandonedMessage(cart)),
      minutesAgo: Math.round((Date.now() - new Date(cart.created_at + 'Z').getTime()) / (1000 * 60))
    };
  });

  // Son gonderilen mesajlar
  const recentLogs = db.prepare(`
    SELECT * FROM whatsapp_logs ORDER BY created_at DESC LIMIT 50
  `).all();

  return { paymentReminders, cartReminders, recentLogs };
}

/**
 * Mesaj gonderildi olarak isaretle (admin butona tikladiginda)
 */
function markAsSent(type, id, phone) {
  logWA(phone, type, type === 'payment_reminder' ? id : null, 'manual_sent', 'sent');
}

module.exports = {
  initWhatsApp,
  stopWhatsApp,
  getDashboardData,
  markAsSent,
  waLink,
  buildPaymentMessage,
  buildAbandonedMessage,
  cleanPhone,
  logWA
};
