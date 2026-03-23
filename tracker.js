/**
 * Anlık Takip (Live Analytics) Module
 * In-memory visitor tracking and event counting
 */

// Aktif ziyaretçiler: sessionId → { lastSeen, page, ip, ua, hasCart, isCheckout }
const visitors = new Map();

// Günlük & haftalık event counter'lar
const events = {
  today: { date: getTodayStr(), pageViews: 0, cartAdds: 0, checkouts: 0, orders: 0, revenue: 0 },
  week: { weekStart: getWeekStartStr(), pageViews: 0, cartAdds: 0, checkouts: 0, orders: 0, revenue: 0 }
};

// Sayfa bazlı görüntüleme (bugün)
const pageViews = new Map();

function getTodayStr() {
  return new Date().toISOString().split('T')[0];
}

function getWeekStartStr() {
  const now = new Date();
  const day = now.getDay() || 7; // Pazartesi = 1
  const monday = new Date(now);
  monday.setDate(now.getDate() - day + 1);
  return monday.toISOString().split('T')[0];
}

// Gün/hafta değişimini kontrol et ve sıfırla
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

// Cihaz tipini user-agent'tan tespit et
function getDevice(ua) {
  if (!ua) return 'desktop';
  ua = ua.toLowerCase();
  if (ua.includes('mobile') || ua.includes('android') || ua.includes('iphone')) return 'mobile';
  if (ua.includes('tablet') || ua.includes('ipad')) return 'tablet';
  return 'desktop';
}

// Sayfa adını güzelleştir
function prettifyPage(path) {
  if (path === '/') return 'Anasayfa';
  if (path.startsWith('/urun/')) return path.replace('/urun/', '').replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  if (path.startsWith('/urunler')) return 'Ürünler';
  if (path === '/sepet') return 'Sepet';
  if (path === '/odeme' || path === '/siparis') return 'Ödeme';
  if (path.startsWith('/siparis/')) return 'Sipariş';
  if (path === '/favoriler') return 'Favoriler';
  return path;
}

/**
 * Her request'te çağrılır — ziyaretçi kaydeder, pageview sayar
 */
function trackRequest(req) {
  // Static dosyaları, API ve admin isteklerini atla
  const path = req.path;
  if (path.startsWith('/css/') || path.startsWith('/js/') || path.startsWith('/uploads/') ||
      path.startsWith('/api/') || path.startsWith('/admin') || path.startsWith('/auth/') ||
      path.includes('.') || path === '/favicon.ico' || path === '/robots.txt' || path === '/sitemap.xml') {
    return;
  }

  checkReset();

  const sessionId = req.sessionID || req.ip;
  const now = Date.now();

  // Ziyaretçi güncelle
  const existing = visitors.get(sessionId);
  const cart = req.session && req.session.cart ? req.session.cart : [];
  const hasCart = cart.length > 0;
  const isCheckout = path === '/odeme' || path === '/siparis';

  visitors.set(sessionId, {
    lastSeen: now,
    page: path,
    pageName: prettifyPage(path),
    ip: req.ip,
    ua: req.get('User-Agent') || '',
    device: getDevice(req.get('User-Agent')),
    hasCart,
    isCheckout,
    cartTotal: hasCart ? cart.reduce((sum, item) => sum + item.price * item.quantity, 0) : 0
  });

  // Sayfa görüntüleme say
  events.today.pageViews++;
  events.week.pageViews++;

  // Sayfa bazlı sayaç
  const pageKey = path.startsWith('/urun/') ? path : path.split('?')[0];
  pageViews.set(pageKey, (pageViews.get(pageKey) || 0) + 1);
}

/**
 * Özel olayları kaydet
 * type: 'cart_add' | 'checkout' | 'order'
 */
function trackEvent(type, value = 0) {
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
}

/**
 * Admin paneli için anlık istatistikleri döner
 */
function getStats() {
  checkReset();

  const now = Date.now();
  const ACTIVE_TIMEOUT = 5 * 60 * 1000; // 5 dakika

  // İnaktif ziyaretçileri temizle
  for (const [id, v] of visitors) {
    if (now - v.lastSeen > ACTIVE_TIMEOUT) visitors.delete(id);
  }

  // Aktif ziyaretçi listesi
  const activeList = [];
  let activeCarts = 0;
  let activeCheckouts = 0;
  let devices = { mobile: 0, desktop: 0, tablet: 0 };

  for (const [id, v] of visitors) {
    const durationMs = now - v.lastSeen;
    const durationMin = Math.max(0, Math.floor(durationMs / 60000));
    const durationStr = durationMin < 1 ? 'Az önce' : `${durationMin}dk`;

    activeList.push({
      page: v.pageName,
      path: v.page,
      duration: durationStr,
      device: v.device,
      hasCart: v.hasCart,
      cartTotal: v.cartTotal
    });

    if (v.hasCart) activeCarts++;
    if (v.isCheckout) activeCheckouts++;
    devices[v.device] = (devices[v.device] || 0) + 1;
  }

  // Popüler sayfalar (bugün, top 10)
  const topPages = Array.from(pageViews.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([page, views]) => ({ page: prettifyPage(page), path: page, views }));

  // Conversion funnel
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
    visitors: activeList.sort((a, b) => a.duration === 'Az önce' ? -1 : 1),
    activeCarts,
    activeCheckouts,
    devices,
    today: todayFunnel,
    thisWeek: {
      pageViews: events.week.pageViews,
      cartAdds: events.week.cartAdds,
      checkouts: events.week.checkouts,
      orders: events.week.orders,
      revenue: events.week.revenue
    },
    topPages
  };
}

// Her 60 saniyede bir eski ziyaretçileri temizle
setInterval(() => {
  const now = Date.now();
  const ACTIVE_TIMEOUT = 5 * 60 * 1000;
  for (const [id, v] of visitors) {
    if (now - v.lastSeen > ACTIVE_TIMEOUT) visitors.delete(id);
  }
}, 60000);

module.exports = { trackRequest, trackEvent, getStats };
