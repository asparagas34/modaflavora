/**
 * Anlık Takip (Live Analytics) Module
 * In-memory visitor tracking + DB-persistent event logging
 */
const { db } = require('./database');

// Aktif ziyaretçiler: sessionId → { lastSeen, page, ip, ua, hasCart, isCheckout }
const visitors = new Map();

// Günlük & haftalık event counter'lar (in-memory, hızlı dashboard için)
const events = {
  today: { date: getTodayStr(), pageViews: 0, cartAdds: 0, checkouts: 0, orders: 0, revenue: 0 },
  week: { weekStart: getWeekStartStr(), pageViews: 0, cartAdds: 0, checkouts: 0, orders: 0, revenue: 0 }
};

// Sayfa bazlı görüntüleme (bugün)
const pageViews = new Map();

// DB insert prepared statements
let insertEvent;
try {
  insertEvent = db.prepare(
    'INSERT INTO site_events (session_id, event_type, page, page_label, device, referrer, cart_total) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
} catch (e) {
  // Tablo henüz oluşmamış olabilir, server restart sonrası düzelir
  insertEvent = null;
}

function getTodayStr() {
  return new Date().toISOString().split('T')[0];
}

function getWeekStartStr() {
  const now = new Date();
  const day = now.getDay() || 7;
  const monday = new Date(now);
  monday.setDate(now.getDate() - day + 1);
  return monday.toISOString().split('T')[0];
}

function checkReset() {
  const today = getTodayStr();
  const weekStart = getWeekStartStr();

  if (events.today.date !== today) {
    events.today = { date: today, pageViews: 0, cartAdds: 0, checkouts: 0, orders: 0, revenue: 0 };
    pageViews.clear();
  }
  if (events.week.weekStart !== weekStart) {
    events.week = { weekStart, pageViews: 0, cartAdds: 0, checkouts: 0, orders: 0, revenue: 0 };
  }
}

function getDevice(ua) {
  if (!ua) return 'desktop';
  ua = ua.toLowerCase();
  if (ua.includes('mobile') || ua.includes('android') || ua.includes('iphone')) return 'mobile';
  if (ua.includes('tablet') || ua.includes('ipad')) return 'tablet';
  return 'desktop';
}

function prettifyPage(path) {
  if (path === '/') return 'Anasayfa';
  if (path.startsWith('/urun/')) return path.replace('/urun/', '').replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  if (path.startsWith('/urunler')) return 'Urunler';
  if (path === '/sepet') return 'Sepet';
  if (path === '/odeme' || path === '/siparis') return 'Odeme';
  if (path.startsWith('/siparis/')) return 'Siparis';
  if (path === '/favoriler') return 'Favoriler';
  return path;
}

// Hangi event type'a karşılık geldiğini belirle
function getEventType(path) {
  if (path === '/') return 'page_home';
  if (path.startsWith('/urun/')) return 'page_product';
  if (path.startsWith('/urunler')) return 'page_products';
  if (path === '/sepet') return 'page_cart';
  if (path === '/siparis' || path === '/odeme') return 'page_checkout';
  if (path.startsWith('/siparis/tamamlandi') || path.startsWith('/siparis/tebrikler')) return 'page_order_complete';
  if (path === '/favoriler') return 'page_favorites';
  return 'page_other';
}

/**
 * Her request'te çağrılır — ziyaretçi kaydeder, pageview sayar, DB'ye yazar
 */
function trackRequest(req) {
  const path = req.path;
  if (path.startsWith('/css/') || path.startsWith('/js/') || path.startsWith('/uploads/') ||
      path.startsWith('/api/') || path.startsWith('/admin') || path.startsWith('/auth/') ||
      path.includes('.') || path === '/favicon.ico' || path === '/robots.txt' || path === '/sitemap.xml') {
    return;
  }

  checkReset();

  const sessionId = req.sessionID || req.ip;
  const now = Date.now();
  const cart = req.session && req.session.cart ? req.session.cart : [];
  const hasCart = cart.length > 0;
  const isCheckout = path === '/odeme' || path === '/siparis';
  const device = getDevice(req.get('User-Agent'));
  const pageName = prettifyPage(path);
  const cartTotal = hasCart ? cart.reduce((sum, item) => sum + item.price * item.quantity, 0) : 0;

  // In-memory güncelle
  visitors.set(sessionId, {
    lastSeen: now, page: path, pageName, ip: req.ip,
    ua: req.get('User-Agent') || '', device, hasCart, isCheckout, cartTotal
  });

  events.today.pageViews++;
  events.week.pageViews++;

  const pageKey = path.startsWith('/urun/') ? path : path.split('?')[0];
  pageViews.set(pageKey, (pageViews.get(pageKey) || 0) + 1);

  // DB'ye persist et
  if (insertEvent) {
    try {
      const eventType = getEventType(path);
      const referrer = req.get('Referer') || '';
      insertEvent.run(sessionId, eventType, path, pageName, device, referrer, cartTotal);
    } catch (e) {
      // Sessiz hata — DB yazma başarısız olursa in-memory devam eder
    }
  }
}

/**
 * Özel olayları kaydet (cart_add, checkout, order)
 */
function trackEvent(type, value = 0, req = null) {
  checkReset();

  switch (type) {
    case 'cart_add':
      events.today.cartAdds++;
      events.week.cartAdds++;
      break;
    case 'checkout':
      events.today.checkouts++;
      events.week.checkouts++;
      break;
    case 'order':
      events.today.orders++;
      events.week.orders++;
      events.today.revenue += value;
      events.week.revenue += value;
      break;
  }

  // DB'ye persist et
  if (insertEvent && req) {
    try {
      const sessionId = req.sessionID || req.ip || 'unknown';
      const device = getDevice(req.get ? req.get('User-Agent') : '');
      const cart = req.session && req.session.cart ? req.session.cart : [];
      const cartTotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
      insertEvent.run(sessionId, type, req.path || '', '', device, '', type === 'order' ? value : cartTotal);
    } catch (e) {}
  }
}

/**
 * Admin paneli için anlık istatistikleri döner
 */
function getStats() {
  checkReset();

  const now = Date.now();
  const ACTIVE_TIMEOUT = 5 * 60 * 1000;

  for (const [id, v] of visitors) {
    if (now - v.lastSeen > ACTIVE_TIMEOUT) visitors.delete(id);
  }

  const activeList = [];
  let activeCarts = 0;
  let activeCheckouts = 0;
  let devices = { mobile: 0, desktop: 0, tablet: 0 };

  for (const [id, v] of visitors) {
    const durationMs = now - v.lastSeen;
    const durationMin = Math.max(0, Math.floor(durationMs / 60000));
    const durationStr = durationMin < 1 ? 'Az once' : `${durationMin}dk`;

    activeList.push({
      page: v.pageName, path: v.page, duration: durationStr,
      device: v.device, hasCart: v.hasCart, cartTotal: v.cartTotal
    });

    if (v.hasCart) activeCarts++;
    if (v.isCheckout) activeCheckouts++;
    devices[v.device] = (devices[v.device] || 0) + 1;
  }

  const topPages = Array.from(pageViews.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([page, views]) => ({ page: prettifyPage(page), path: page, views }));

  const todayFunnel = {
    pageViews: events.today.pageViews,
    cartAdds: events.today.cartAdds,
    checkouts: events.today.checkouts,
    orders: events.today.orders,
    revenue: events.today.revenue,
    cartRate: events.today.pageViews > 0 ? ((events.today.cartAdds / events.today.pageViews) * 100).toFixed(1) : '0',
    checkoutRate: events.today.cartAdds > 0 ? ((events.today.checkouts / events.today.cartAdds) * 100).toFixed(1) : '0',
    orderRate: events.today.checkouts > 0 ? ((events.today.orders / events.today.checkouts) * 100).toFixed(1) : '0'
  };

  return {
    activeVisitors: visitors.size,
    visitors: activeList.sort((a, b) => a.duration === 'Az once' ? -1 : 1),
    activeCarts, activeCheckouts, devices,
    today: todayFunnel,
    thisWeek: {
      pageViews: events.week.pageViews, cartAdds: events.week.cartAdds,
      checkouts: events.week.checkouts, orders: events.week.orders, revenue: events.week.revenue
    },
    topPages
  };
}

// Her 60 saniyede eski ziyaretçileri temizle
setInterval(() => {
  const now = Date.now();
  const ACTIVE_TIMEOUT = 5 * 60 * 1000;
  for (const [id, v] of visitors) {
    if (now - v.lastSeen > ACTIVE_TIMEOUT) visitors.delete(id);
  }
}, 60000);

// Her gece 03:00'te 90 günden eski event'leri sil (DB şişmesin)
setInterval(() => {
  try {
    db.prepare("DELETE FROM site_events WHERE created_at < datetime('now', '-90 days')").run();
  } catch (e) {}
}, 24 * 60 * 60 * 1000);

module.exports = { trackRequest, trackEvent, getStats };
