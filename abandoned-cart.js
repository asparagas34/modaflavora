/**
 * Terk Edilen Sepet Otomasyonu
 *
 * Tracker'dan gelen checkout sayfasına ulaşmış ama sipariş vermemiş
 * kullanıcıların sepetlerini belirli süre sonra e-posta ile hatırlatır.
 */
const { db, getSettings } = require('./database');
const { sendMail, abandonedCartEmail } = require('./mailer');

let checkInterval = null;

function startAbandonedCartChecker() {
  // Önceki interval'i temizle
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }

  const settings = getSettings();
  if (settings.abandoned_cart_enabled !== '1') {
    console.log('[AbandonedCart] Otomasyon kapalı.');
    return;
  }

  // Her 5 dakikada kontrol et
  checkInterval = setInterval(() => {
    try {
      checkAbandonedCarts();
    } catch (e) {
      console.error('[AbandonedCart] Hata:', e.message);
    }
  }, 5 * 60 * 1000);

  console.log('[AbandonedCart] Otomasyon başlatıldı.');
}

function stopAbandonedCartChecker() {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
    console.log('[AbandonedCart] Otomasyon durduruldu.');
  }
}

/**
 * Checkout sayfasına gelip X dakika içinde sipariş vermemiş,
 * e-posta adresi bilinen kullanıcılara hatırlatma gönder
 */
function checkAbandonedCarts() {
  const settings = getSettings();
  if (settings.abandoned_cart_enabled !== '1') return;

  const delayMinutes = parseInt(settings.abandoned_cart_delay) || 30;

  // Henüz mail gönderilmemiş, en az X dakika önce oluşturulmuş kayıtları bul
  const carts = db.prepare(`
    SELECT * FROM abandoned_cart_logs
    WHERE email_sent = 0
    AND email IS NOT NULL AND email != ''
    AND created_at <= datetime('now', '-${delayMinutes} minutes')
    ORDER BY created_at ASC
    LIMIT 10
  `).all();

  if (carts.length === 0) return;

  console.log(`[AbandonedCart] ${carts.length} terk edilmiş sepet bulundu.`);

  for (const cart of carts) {
    // Bu e-posta ile sipariş var mı kontrol et (belki sonradan tamamlamıştır)
    const hasOrder = db.prepare(
      "SELECT id FROM orders WHERE guest_email = ? AND created_at > ? LIMIT 1"
    ).get(cart.email, cart.created_at);

    if (hasOrder) {
      // Sipariş vermiş, recovered olarak işaretle
      db.prepare('UPDATE abandoned_cart_logs SET recovered = 1, email_sent = 1 WHERE id = ?').run(cart.id);
      continue;
    }

    // Mail gönder
    const subject = settings.abandoned_cart_subject || 'Sepetinizde ürünler sizi bekliyor!';
    const html = abandonedCartEmail(cart.guest_name, cart.cart_data, cart.cart_total, settings);

    sendMail({ to: cart.email, subject, html }).then(sent => {
      if (sent) {
        db.prepare("UPDATE abandoned_cart_logs SET email_sent = 1, sent_at = datetime('now') WHERE id = ?").run(cart.id);
        console.log(`[AbandonedCart] Mail gönderildi: ${cart.email}`);
      }
    }).catch(err => {
      console.error(`[AbandonedCart] Mail hatası: ${err.message}`);
    });
  }
}

/**
 * Checkout sayfasına ulaşan kullanıcının sepetini kaydet
 * (shop.js checkout GET route'undan çağrılır)
 */
function logCheckoutVisit(req) {
  try {
    const cart = req.session.cart || [];
    if (cart.length === 0) return;

    const sessionId = req.sessionID;
    const email = req.session.checkoutEmail || req.body?.email || '';
    const phone = req.session.checkoutPhone || '';
    const name = req.session.checkoutName || '';

    if (!email) return; // E-posta yoksa loglama

    // Son 1 saat içinde aynı session için kayıt var mı
    const existing = db.prepare(
      "SELECT id FROM abandoned_cart_logs WHERE session_id = ? AND created_at > datetime('now', '-1 hour')"
    ).get(sessionId);

    if (existing) return; // Tekrar kaydetme

    const cartTotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);

    db.prepare(
      'INSERT INTO abandoned_cart_logs (session_id, email, phone, guest_name, cart_data, cart_total) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(sessionId, email, phone, name, JSON.stringify(cart), cartTotal);
  } catch (e) {
    // Sessiz hata
  }
}

/**
 * Sipariş tamamlandığında abandoned cart logunu recovered olarak işaretle
 */
function markCartRecovered(email) {
  if (!email) return;
  try {
    db.prepare(
      "UPDATE abandoned_cart_logs SET recovered = 1 WHERE email = ? AND email_sent = 0"
    ).run(email);
  } catch (e) {}
}

module.exports = {
  startAbandonedCartChecker,
  stopAbandonedCartChecker,
  logCheckoutVisit,
  markCartRecovered
};
