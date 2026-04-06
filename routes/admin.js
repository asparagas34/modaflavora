const express = require('express');
const router = express.Router();
const { initBot } = require('../telegram');
const { resetTransporter, sendMail } = require('../mailer');
const { startAbandonedCartChecker, stopAbandonedCartChecker } = require('../abandoned-cart');
const { getDashboardData, markAsSent, initWhatsApp, stopWhatsApp } = require('../whatsapp');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { db, getSettings } = require('../database');
const { isAdmin } = require('../middleware/auth');
const { getStats } = require('../tracker');

// Multer config
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

router.use(isAdmin);

// Dashboard
router.get('/', (req, res) => {
  const stats = {
    totalProducts: db.prepare('SELECT COUNT(*) as c FROM products').get().c,
    activeProducts: db.prepare('SELECT COUNT(*) as c FROM products WHERE is_active = 1').get().c,
    totalOrders: db.prepare('SELECT COUNT(*) as c FROM orders').get().c,
    pendingOrders: db.prepare("SELECT COUNT(*) as c FROM orders WHERE status = 'pending'").get().c,
    totalRevenue: db.prepare('SELECT COALESCE(SUM(total), 0) as c FROM orders').get().c,
    totalUsers: db.prepare('SELECT COUNT(*) as c FROM users WHERE is_admin = 0').get().c,
    recentOrders: db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 10').all(),
    todayOrders: db.prepare("SELECT COUNT(*) as c FROM orders WHERE date(created_at) = date('now')").get().c,
    todayRevenue: db.prepare("SELECT COALESCE(SUM(total), 0) as c FROM orders WHERE date(created_at) = date('now')").get().c
  };
  res.render('admin/dashboard', { stats, layout: false });
});

// Products
router.get('/urunler', (req, res) => {
  const { ara, kategori, sayfa } = req.query;
  const limit = 50;
  const page = Math.max(1, parseInt(sayfa) || 1);
  const offset = (page - 1) * limit;

  let where = '1=1';
  const params = [];
  if (ara) { where += ' AND p.name LIKE ?'; params.push(`%${ara}%`); }
  if (kategori) { where += ' AND p.category_id = ?'; params.push(kategori); }

  const total = db.prepare(`SELECT COUNT(*) as c FROM products p WHERE ${where}`).get(...params).c;
  const products = db.prepare(
    `SELECT p.*, c.name as category_name FROM products p
     LEFT JOIN categories c ON p.category_id = c.id
     WHERE ${where} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);
  const categories = db.prepare('SELECT id, name FROM categories WHERE is_active=1 ORDER BY name').all();

  res.render('admin/products', {
    products, categories, layout: false,
    total, page, totalPages: Math.ceil(total / limit),
    query: req.query
  });
});

router.get('/urunler/ekle', (req, res) => {
  const categories = db.prepare('SELECT * FROM categories WHERE is_active = 1 ORDER BY name').all();
  res.render('admin/product-form', { product: null, categories, layout: false });
});

router.get('/urunler/duzenle/:id', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.redirect('/admin/urunler');
  const categories = db.prepare('SELECT * FROM categories WHERE is_active = 1 ORDER BY name').all();
  res.render('admin/product-form', { product, categories, layout: false });
});

router.post('/urunler/kaydet', upload.single('image'), (req, res) => {
  const { id, name, description, price, sale_price, category_id, sizes, colors, stock, is_active, is_featured, is_new } = req.body;
  const slug = name.toLowerCase()
    .replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's')
    .replace(/ı/g, 'i').replace(/ö/g, 'o').replace(/ç/g, 'c')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  const image = req.file ? '/uploads/' + req.file.filename : (id ? db.prepare('SELECT image FROM products WHERE id = ?').get(id)?.image : null);

  if (id) {
    db.prepare(
      `UPDATE products SET name=?, slug=?, description=?, price=?, sale_price=?, category_id=?,
       image=?, sizes=?, colors=?, stock=?, is_active=?, is_featured=?, is_new=? WHERE id=?`
    ).run(name, slug, description || '', parseFloat(price), sale_price ? parseFloat(sale_price) : null,
      parseInt(category_id) || null, image, sizes || '[]', colors || '[]',
      parseInt(stock) || 0, is_active ? 1 : 0, is_featured ? 1 : 0, is_new ? 1 : 0, id);
  } else {
    db.prepare(
      `INSERT INTO products (name, slug, description, price, sale_price, category_id, image, sizes, colors, stock, is_active, is_featured, is_new)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(name, slug, description || '', parseFloat(price), sale_price ? parseFloat(sale_price) : null,
      parseInt(category_id) || null, image, sizes || '[]', colors || '[]',
      parseInt(stock) || 0, is_active ? 1 : 0, is_featured ? 1 : 0, is_new ? 1 : 0);
  }

  res.redirect('/admin/urunler');
});

router.post('/urunler/sil/:id', (req, res) => {
  db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  res.redirect('/admin/urunler');
});

// Categories
router.get('/kategoriler', (req, res) => {
  const categories = db.prepare(
    `SELECT c.*, p.name as parent_name,
     (SELECT COUNT(*) FROM products WHERE category_id = c.id) as product_count
     FROM categories c LEFT JOIN categories p ON c.parent_id = p.id ORDER BY c.sort_order`
  ).all();
  res.render('admin/categories', { categories, layout: false });
});

router.post('/kategoriler/kaydet', upload.single('image'), (req, res) => {
  const { id, name, parent_id, sort_order, is_active } = req.body;
  const slug = name.toLowerCase()
    .replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's')
    .replace(/ı/g, 'i').replace(/ö/g, 'o').replace(/ç/g, 'c')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const image = req.file ? '/uploads/' + req.file.filename : (id ? db.prepare('SELECT image FROM categories WHERE id = ?').get(id)?.image : null);

  if (id) {
    db.prepare('UPDATE categories SET name=?, slug=?, parent_id=?, image=?, sort_order=?, is_active=? WHERE id=?')
      .run(name, slug, parent_id ? parseInt(parent_id) : null, image, parseInt(sort_order) || 0, is_active ? 1 : 0, id);
  } else {
    db.prepare('INSERT INTO categories (name, slug, parent_id, image, sort_order, is_active) VALUES (?, ?, ?, ?, ?, ?)')
      .run(name, slug, parent_id ? parseInt(parent_id) : null, image, parseInt(sort_order) || 0, is_active ? 1 : 0);
  }
  res.redirect('/admin/kategoriler');
});

router.post('/kategoriler/sil/:id', (req, res) => {
  db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
  res.redirect('/admin/kategoriler');
});

// Toplu fiyat güncelleme
router.post('/urunler/toplu-fiyat', (req, res) => {
  const { islem, oran, sabit_fiyat, kategori_id, indirimli, productIds, selectAll, ara } = req.body;
  let query = 'SELECT id, price, sale_price FROM products WHERE 1=1';
  const params = [];

  if (selectAll === '1') {
    // Tüm filtrelenmiş ürünler
    if (kategori_id) { query += ' AND category_id = ?'; params.push(parseInt(kategori_id)); }
    if (ara) { query += ' AND name LIKE ?'; params.push(`%${ara}%`); }
  } else if (productIds && productIds.length > 0) {
    // Sadece seçili ürünler
    const ids = Array.isArray(productIds) ? productIds : [productIds];
    query += ` AND id IN (${ids.map(() => '?').join(',')})`;
    params.push(...ids.map(Number));
  } else {
    // Eski davranış: kategori filtresi
    if (kategori_id) { query += ' AND category_id = ?'; params.push(parseInt(kategori_id)); }
  }
  const products = db.prepare(query).all(...params);

  const updateStmt = db.prepare('UPDATE products SET price = ?, sale_price = ? WHERE id = ?');
  const transaction = db.transaction(() => {
    products.forEach(p => {
      let newPrice = p.price;
      let newSalePrice = p.sale_price;
      const target = indirimli === '1' ? 'sale' : 'price';

      if (islem === 'artir_oran') {
        const multiplier = 1 + (parseFloat(oran) / 100);
        if (target === 'price') newPrice = Math.round(p.price * multiplier * 100) / 100;
        else newSalePrice = p.sale_price ? Math.round(p.sale_price * multiplier * 100) / 100 : null;
      } else if (islem === 'indir_oran') {
        const multiplier = 1 - (parseFloat(oran) / 100);
        if (target === 'price') newPrice = Math.round(p.price * multiplier * 100) / 100;
        else newSalePrice = p.sale_price ? Math.round(p.sale_price * multiplier * 100) / 100 : null;
      } else if (islem === 'sabit_indirim') {
        const amount = parseFloat(sabit_fiyat);
        if (target === 'price') newPrice = Math.max(0, Math.round((p.price - amount) * 100) / 100);
        else newSalePrice = p.sale_price ? Math.max(0, Math.round((p.sale_price - amount) * 100) / 100) : null;
      } else if (islem === 'indirim_ekle') {
        newSalePrice = Math.round(p.price * (1 - parseFloat(oran) / 100) * 100) / 100;
      } else if (islem === 'indirim_kaldir') {
        newSalePrice = null;
      } else if (islem === 'sabit_fiyat') {
        if (target === 'price') newPrice = parseFloat(sabit_fiyat);
        else newSalePrice = parseFloat(sabit_fiyat);
      }
      updateStmt.run(newPrice, newSalePrice, p.id);
    });
  });
  transaction();
  res.json({ success: true, updated: products.length });
});

// İstatistikler sayfası
router.get('/istatistikler', (req, res) => {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().slice(0, 10);

  const startDate = req.query.baslangic || thirtyDaysAgoStr;
  const endDate = req.query.bitis || todayStr;

  // Günlük istatistikler
  const dailyData = db.prepare(`
    SELECT date(created_at) as date, COUNT(*) as orders, COALESCE(SUM(total),0) as revenue
    FROM orders
    WHERE date(created_at) BETWEEN ? AND ? AND status != 'cancelled'
    GROUP BY date(created_at)
    ORDER BY date
  `).all(startDate, endDate);

  // Dönem toplamları
  const stats = db.prepare(`
    SELECT
      COUNT(*) as totalOrders,
      COALESCE(SUM(total), 0) as totalRevenue,
      COALESCE(AVG(total), 0) as avgOrder
    FROM orders
    WHERE date(created_at) BETWEEN ? AND ? AND status != 'cancelled'
  `).get(startDate, endDate);

  // Bu hafta vs geçen hafta
  const thisWeek = db.prepare(`
    SELECT COUNT(*) as orders, COALESCE(SUM(total),0) as revenue
    FROM orders
    WHERE date(created_at) >= date('now', 'weekday 0', '-7 days')
      AND date(created_at) < date('now', 'weekday 0')
      AND status != 'cancelled'
  `).get();

  const lastWeek = db.prepare(`
    SELECT COUNT(*) as orders, COALESCE(SUM(total),0) as revenue
    FROM orders
    WHERE date(created_at) >= date('now', 'weekday 0', '-14 days')
      AND date(created_at) < date('now', 'weekday 0', '-7 days')
      AND status != 'cancelled'
  `).get();

  // Top 10 ürünler
  const topProducts = db.prepare(`
    SELECT p.name, p.image, SUM(oi.quantity) as sold, SUM(oi.price * oi.quantity) as revenue
    FROM order_items oi
    JOIN products p ON oi.product_id = p.id
    JOIN orders o ON oi.order_id = o.id
    WHERE date(o.created_at) BETWEEN ? AND ? AND o.status != 'cancelled'
    GROUP BY p.id
    ORDER BY sold DESC
    LIMIT 10
  `).all(startDate, endDate);

  // Kategori dağılımı
  const categoryStats = db.prepare(`
    SELECT c.name, COALESCE(SUM(oi.quantity), 0) as sold, COALESCE(SUM(oi.price * oi.quantity), 0) as revenue
    FROM order_items oi
    JOIN products p ON oi.product_id = p.id
    JOIN categories c ON p.category_id = c.id
    JOIN orders o ON oi.order_id = o.id
    WHERE date(o.created_at) BETWEEN ? AND ? AND o.status != 'cancelled'
    GROUP BY c.id
    ORDER BY sold DESC
  `).all(startDate, endDate);

  res.render('admin/stats', {
    stats,
    dailyData,
    topProducts,
    categoryStats,
    startDate,
    endDate,
    thisWeek,
    lastWeek,
    layout: false
  });
});

// İstatistik API
router.get('/istatistik-data', (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const dailyOrders = db.prepare(`
    SELECT date(created_at) as date, COUNT(*) as orders, COALESCE(SUM(total), 0) as revenue
    FROM orders WHERE created_at >= date('now', '-' || ? || ' days')
    GROUP BY date(created_at) ORDER BY date
  `).all(days);
  const categoryStats = db.prepare(`
    SELECT c.name, COUNT(oi.id) as sold
    FROM order_items oi
    JOIN products p ON oi.product_id = p.id
    JOIN categories c ON p.category_id = c.id
    GROUP BY c.id ORDER BY sold DESC LIMIT 8
  `).all();
  const topProducts = db.prepare(`
    SELECT p.name, p.image, SUM(oi.quantity) as sold, SUM(oi.price * oi.quantity) as revenue
    FROM order_items oi JOIN products p ON oi.product_id = p.id
    GROUP BY p.id ORDER BY sold DESC LIMIT 10
  `).all();
  res.json({ dailyOrders, categoryStats, topProducts });
});

// Orders
router.get('/siparisler', (req, res) => {
  const orders = db.prepare(
    `SELECT o.*, u.name as user_name FROM orders o
     LEFT JOIN users u ON o.user_id = u.id ORDER BY o.created_at DESC`
  ).all();
  res.render('admin/orders', { orders, layout: false });
});

router.get('/siparisler/:id', (req, res) => {
  const order = db.prepare(
    `SELECT o.*, u.name as user_name, u.email as user_email FROM orders o
     LEFT JOIN users u ON o.user_id = u.id WHERE o.id = ?`
  ).get(req.params.id);
  if (!order) return res.redirect('/admin/siparisler');
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
  res.render('admin/order-detail', { order, items, layout: false });
});

router.post('/siparisler/durum/:id', (req, res) => {
  const { status } = req.body;
  const oldOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, req.params.id);

  // EFT siparis onaylandiginda Meta Purchase event tetikle
  if (status === 'processing' && oldOrder && oldOrder.payment_method === 'eft' && oldOrder.status === 'pending_payment') {
    try {
      const { triggerPurchaseForOrder } = require('../meta-capi');
      triggerPurchaseForOrder(parseInt(req.params.id));
    } catch (e) { console.error('[CAPI] Admin purchase trigger:', e.message); }
  }

  // Kargo bildirimi
  if (status === 'shipped') {
    const settings = getSettings();
    if (settings.shipping_notification_enabled === '1') {
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
      const email = order?.guest_email;
      if (email) {
        const { shippingNotificationEmail } = require('../mailer');
        sendMail({ to: email, subject: `Siparişiniz Kargoya Verildi! #${order.id}`, html: shippingNotificationEmail(order, settings) })
          .catch(e => console.error('[Mail] Shipping:', e.message));
      }
    }
  }

  res.redirect('/admin/siparisler/' + req.params.id);
});

// Sliders
router.get('/slider', (req, res) => {
  const sliders = db.prepare('SELECT * FROM sliders ORDER BY sort_order').all();
  res.render('admin/sliders', { sliders, layout: false });
});

router.post('/slider/kaydet', upload.single('image'), (req, res) => {
  const { id, title, subtitle, link, sort_order, is_active } = req.body;
  const image = req.file ? '/uploads/' + req.file.filename : (id ? db.prepare('SELECT image FROM sliders WHERE id = ?').get(id)?.image : null);

  if (id) {
    db.prepare('UPDATE sliders SET title=?, subtitle=?, image=?, link=?, sort_order=?, is_active=? WHERE id=?')
      .run(title || '', subtitle || '', image, link || '', parseInt(sort_order) || 0, is_active ? 1 : 0, id);
  } else {
    db.prepare('INSERT INTO sliders (title, subtitle, image, link, sort_order, is_active) VALUES (?, ?, ?, ?, ?, ?)')
      .run(title || '', subtitle || '', image, link || '', parseInt(sort_order) || 0, is_active ? 1 : 0);
  }
  res.redirect('/admin/slider');
});

router.post('/slider/sil/:id', (req, res) => {
  db.prepare('DELETE FROM sliders WHERE id = ?').run(req.params.id);
  res.redirect('/admin/slider');
});

// Yorumlar yönetimi
router.get('/yorumlar', (req, res) => {
  const filter = req.query.filter || 'all'; // all, pending, approved
  let where = '';
  if (filter === 'pending') where = ' WHERE r.is_approved = 0';
  else if (filter === 'approved') where = ' WHERE r.is_approved = 1';

  const reviews = db.prepare(
    `SELECT r.*, p.name as product_name, p.slug as product_slug, p.image as product_image
     FROM reviews r LEFT JOIN products p ON r.product_id = p.id
     ${where} ORDER BY r.created_at DESC`
  ).all();
  const pendingCount = db.prepare('SELECT COUNT(*) as c FROM reviews WHERE is_approved = 0').get().c;
  res.render('admin/reviews', { reviews, filter, pendingCount, layout: false });
});

router.post('/yorumlar/onayla/:id', (req, res) => {
  db.prepare('UPDATE reviews SET is_approved = 1 WHERE id = ?').run(req.params.id);
  res.redirect('/admin/yorumlar?filter=pending');
});

router.post('/yorumlar/sil/:id', (req, res) => {
  db.prepare('DELETE FROM reviews WHERE id = ?').run(req.params.id);
  res.redirect('/admin/yorumlar');
});

router.post('/yorumlar/dogrula/:id', (req, res) => {
  db.prepare('UPDATE reviews SET is_verified = 1 WHERE id = ?').run(req.params.id);
  res.redirect('/admin/yorumlar');
});

// SMTP Test
router.post('/api/test-smtp', async (req, res) => {
  const settings = getSettings();
  if (!settings.smtp_host || !settings.smtp_user) {
    return res.json({ success: false, error: 'SMTP ayarları eksik' });
  }
  try {
    resetTransporter();
    const sent = await sendMail({
      to: settings.smtp_user,
      subject: `${settings.site_name || 'FLAVORA'} — SMTP Test`,
      html: `<div style="font-family:sans-serif;padding:20px;"><h2>SMTP Test Başarılı!</h2><p>E-posta ayarlarınız doğru çalışıyor.</p><p style="color:#6b7280;font-size:12px;">${new Date().toLocaleString('tr-TR')}</p></div>`
    });
    res.json({ success: sent });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Anlık takip API
router.get('/api/canli', (req, res) => {
  res.json(getStats());
});

// ═══════════════════════════════════════════════════════════════
// DETAYLI ANALİTİK SAYFASI
// ═══════════════════════════════════════════════════════════════
router.get('/analitik', (req, res) => {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().slice(0, 10);

  const startDate = req.query.baslangic || thirtyDaysAgoStr;
  const endDate = req.query.bitis || todayStr;

  // 1) Genel KPI'lar
  const kpi = db.prepare(`
    SELECT
      COUNT(*) as totalOrders,
      COALESCE(SUM(total), 0) as totalRevenue,
      COALESCE(AVG(total), 0) as avgOrder,
      COUNT(DISTINCT guest_email) as uniqueCustomers
    FROM orders
    WHERE date(created_at) BETWEEN ? AND ? AND status != 'cancelled'
  `).get(startDate, endDate);

  // 2) Durum dagilimi
  const statusBreakdown = db.prepare(`
    SELECT status, COUNT(*) as count, COALESCE(SUM(total),0) as revenue
    FROM orders
    WHERE date(created_at) BETWEEN ? AND ?
    GROUP BY status
    ORDER BY count DESC
  `).all(startDate, endDate);

  // 3) Gunluk trend
  const dailyData = db.prepare(`
    SELECT date(created_at) as date, COUNT(*) as orders, COALESCE(SUM(total),0) as revenue
    FROM orders
    WHERE date(created_at) BETWEEN ? AND ? AND status != 'cancelled'
    GROUP BY date(created_at)
    ORDER BY date
  `).all(startDate, endDate);

  // 4) Saat bazli siparis dagilimi (hangi saatte siparis geliyor)
  const hourlyData = db.prepare(`
    SELECT
      CAST(strftime('%H', created_at) AS INTEGER) as hour,
      COUNT(*) as orders,
      COALESCE(SUM(total),0) as revenue
    FROM orders
    WHERE date(created_at) BETWEEN ? AND ? AND status != 'cancelled'
    GROUP BY hour
    ORDER BY hour
  `).all(startDate, endDate);

  // 5) Gun bazli siparis dagilimi (hangi gun siparis geliyor)
  const weekdayData = db.prepare(`
    SELECT
      CASE CAST(strftime('%w', created_at) AS INTEGER)
        WHEN 0 THEN 'Pazar'
        WHEN 1 THEN 'Pazartesi'
        WHEN 2 THEN 'Sali'
        WHEN 3 THEN 'Carsamba'
        WHEN 4 THEN 'Persembe'
        WHEN 5 THEN 'Cuma'
        WHEN 6 THEN 'Cumartesi'
      END as dayName,
      CAST(strftime('%w', created_at) AS INTEGER) as dayNum,
      COUNT(*) as orders,
      COALESCE(SUM(total),0) as revenue
    FROM orders
    WHERE date(created_at) BETWEEN ? AND ? AND status != 'cancelled'
    GROUP BY dayNum
    ORDER BY dayNum
  `).all(startDate, endDate);

  // 6) Sehir bazli siparis
  const cityData = db.prepare(`
    SELECT city, COUNT(*) as orders, COALESCE(SUM(total),0) as revenue,
      COALESCE(AVG(total),0) as avgOrder
    FROM orders
    WHERE date(created_at) BETWEEN ? AND ? AND status != 'cancelled' AND city IS NOT NULL AND city != ''
    GROUP BY city
    ORDER BY orders DESC
    LIMIT 20
  `).all(startDate, endDate);

  // 7) Odeme yontemi dagilimi
  const paymentData = db.prepare(`
    SELECT payment_method, COUNT(*) as orders, COALESCE(SUM(total),0) as revenue
    FROM orders
    WHERE date(created_at) BETWEEN ? AND ? AND status != 'cancelled'
    GROUP BY payment_method
  `).all(startDate, endDate);

  // 8) Top 10 urunler
  const topProducts = db.prepare(`
    SELECT p.name, p.slug, p.image, p.price, p.sale_price,
      SUM(oi.quantity) as sold,
      SUM(oi.price * oi.quantity) as revenue,
      COUNT(DISTINCT oi.order_id) as orderCount
    FROM order_items oi
    JOIN products p ON oi.product_id = p.id
    JOIN orders o ON oi.order_id = o.id
    WHERE date(o.created_at) BETWEEN ? AND ? AND o.status != 'cancelled'
    GROUP BY p.id
    ORDER BY sold DESC
    LIMIT 15
  `).all(startDate, endDate);

  // 9) Kategori dagilimi
  const categoryData = db.prepare(`
    SELECT c.name, SUM(oi.quantity) as sold, SUM(oi.price * oi.quantity) as revenue
    FROM order_items oi
    JOIN products p ON oi.product_id = p.id
    JOIN categories c ON p.category_id = c.id
    JOIN orders o ON oi.order_id = o.id
    WHERE date(o.created_at) BETWEEN ? AND ? AND o.status != 'cancelled'
    GROUP BY c.id
    ORDER BY revenue DESC
  `).all(startDate, endDate);

  // 10) Terk edilen sepet analizi
  const abandonedStats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN recovered = 1 THEN 1 ELSE 0 END) as recovered,
      SUM(CASE WHEN email_sent = 1 AND recovered = 0 THEN 1 ELSE 0 END) as emailSentNotRecovered,
      SUM(CASE WHEN email_sent = 0 AND recovered = 0 THEN 1 ELSE 0 END) as noAction,
      COALESCE(SUM(cart_total), 0) as totalValue,
      COALESCE(SUM(CASE WHEN recovered = 0 THEN cart_total ELSE 0 END), 0) as lostValue,
      COALESCE(SUM(CASE WHEN recovered = 1 THEN cart_total ELSE 0 END), 0) as recoveredValue
    FROM abandoned_cart_logs
    WHERE date(created_at) BETWEEN ? AND ?
  `).get(startDate, endDate);

  // 11) Son terk edilen sepetler
  const recentAbandoned = db.prepare(`
    SELECT email, guest_name, cart_total, cart_data, email_sent, recovered, created_at
    FROM abandoned_cart_logs
    WHERE date(created_at) BETWEEN ? AND ?
    ORDER BY created_at DESC
    LIMIT 20
  `).all(startDate, endDate);

  // 12) Siparis degeri dagilimi (kac adet siparis hangi fiyat araliginda)
  const orderValueBuckets = db.prepare(`
    SELECT
      CASE
        WHEN total < 250 THEN '0-250'
        WHEN total < 500 THEN '250-500'
        WHEN total < 1000 THEN '500-1K'
        WHEN total < 2000 THEN '1K-2K'
        WHEN total < 5000 THEN '2K-5K'
        ELSE '5K+'
      END as bucket,
      COUNT(*) as orders,
      COALESCE(SUM(total),0) as revenue
    FROM orders
    WHERE date(created_at) BETWEEN ? AND ? AND status != 'cancelled'
    GROUP BY bucket
    ORDER BY MIN(total)
  `).all(startDate, endDate);

  // 13) Tekrar eden musteriler
  const repeatCustomers = db.prepare(`
    SELECT guest_email, COUNT(*) as orderCount, COALESCE(SUM(total),0) as totalSpent,
      MIN(created_at) as firstOrder, MAX(created_at) as lastOrder
    FROM orders
    WHERE date(created_at) BETWEEN ? AND ? AND status != 'cancelled' AND guest_email IS NOT NULL AND guest_email != ''
    GROUP BY guest_email
    HAVING orderCount > 1
    ORDER BY totalSpent DESC
    LIMIT 15
  `).all(startDate, endDate);

  // 14) Beden dagilimi (en cok hangi bedenler satiliyor)
  const sizeData = db.prepare(`
    SELECT oi.size, SUM(oi.quantity) as sold
    FROM order_items oi
    JOIN orders o ON oi.order_id = o.id
    WHERE date(o.created_at) BETWEEN ? AND ? AND o.status != 'cancelled'
      AND oi.size IS NOT NULL AND oi.size != ''
    GROUP BY oi.size
    ORDER BY sold DESC
  `).all(startDate, endDate);

  // 15) Anlik tracker verileri
  const liveStats = getStats();

  // 16) KALICI DONUSUM HUNİSİ (site_events tablosundan)
  let persistentFunnel = { sessions: 0, productViews: 0, cartAdds: 0, cartViews: 0, checkoutStarts: 0, orderCompletes: 0 };
  let deviceFunnel = [];
  let topDropoffPages = [];
  let userJourneys = [];
  let dailyFunnel = [];

  try {
    // Toplam benzersiz session ve adim bazli sayilar
    persistentFunnel = db.prepare(`
      SELECT
        COUNT(DISTINCT session_id) as sessions,
        COUNT(DISTINCT CASE WHEN event_type = 'page_product' THEN session_id END) as productViews,
        COUNT(DISTINCT CASE WHEN event_type = 'cart_add' THEN session_id END) as cartAdds,
        COUNT(DISTINCT CASE WHEN event_type = 'page_cart' THEN session_id END) as cartViews,
        COUNT(DISTINCT CASE WHEN event_type IN ('page_checkout','checkout') THEN session_id END) as checkoutStarts,
        COUNT(DISTINCT CASE WHEN event_type IN ('page_order_complete','order') THEN session_id END) as orderCompletes
      FROM site_events
      WHERE date(created_at) BETWEEN ? AND ?
    `).get(startDate, endDate) || persistentFunnel;

    // Cihaz bazli funnel
    deviceFunnel = db.prepare(`
      SELECT
        device,
        COUNT(DISTINCT session_id) as sessions,
        COUNT(DISTINCT CASE WHEN event_type = 'page_product' THEN session_id END) as productViews,
        COUNT(DISTINCT CASE WHEN event_type = 'cart_add' THEN session_id END) as cartAdds,
        COUNT(DISTINCT CASE WHEN event_type IN ('page_checkout','checkout') THEN session_id END) as checkoutStarts,
        COUNT(DISTINCT CASE WHEN event_type IN ('page_order_complete','order') THEN session_id END) as orderCompletes
      FROM site_events
      WHERE date(created_at) BETWEEN ? AND ?
      GROUP BY device
      ORDER BY sessions DESC
    `).all(startDate, endDate);

    // Kullanicilarin en son gordugu sayfa (terk ettigi yer) - siparis vermeyenler
    topDropoffPages = db.prepare(`
      SELECT last_page, last_label, COUNT(*) as count
      FROM (
        SELECT session_id,
          (SELECT page FROM site_events e2 WHERE e2.session_id = e1.session_id AND date(e2.created_at) BETWEEN ? AND ? ORDER BY e2.created_at DESC LIMIT 1) as last_page,
          (SELECT page_label FROM site_events e2 WHERE e2.session_id = e1.session_id AND date(e2.created_at) BETWEEN ? AND ? ORDER BY e2.created_at DESC LIMIT 1) as last_label
        FROM site_events e1
        WHERE date(e1.created_at) BETWEEN ? AND ?
        GROUP BY session_id
        HAVING SUM(CASE WHEN event_type IN ('page_order_complete','order') THEN 1 ELSE 0 END) = 0
      )
      GROUP BY last_page
      ORDER BY count DESC
      LIMIT 10
    `).all(startDate, endDate, startDate, endDate, startDate, endDate);

    // Son 20 kullanici yolculugu (session bazli ozet)
    userJourneys = db.prepare(`
      SELECT
        session_id,
        MIN(created_at) as first_seen,
        MAX(created_at) as last_seen,
        COUNT(*) as page_count,
        device,
        GROUP_CONCAT(event_type, ' > ') as journey,
        MAX(CASE WHEN event_type IN ('page_order_complete','order') THEN 1 ELSE 0 END) as converted,
        MAX(cart_total) as max_cart_total
      FROM site_events
      WHERE date(created_at) BETWEEN ? AND ?
      GROUP BY session_id
      ORDER BY first_seen DESC
      LIMIT 30
    `).all(startDate, endDate);

    // Gunluk funnel trend
    dailyFunnel = db.prepare(`
      SELECT
        date(created_at) as date,
        COUNT(DISTINCT session_id) as sessions,
        COUNT(DISTINCT CASE WHEN event_type = 'page_product' THEN session_id END) as productViews,
        COUNT(DISTINCT CASE WHEN event_type = 'cart_add' THEN session_id END) as cartAdds,
        COUNT(DISTINCT CASE WHEN event_type IN ('page_checkout','checkout') THEN session_id END) as checkouts,
        COUNT(DISTINCT CASE WHEN event_type IN ('page_order_complete','order') THEN session_id END) as orders
      FROM site_events
      WHERE date(created_at) BETWEEN ? AND ?
      GROUP BY date(created_at)
      ORDER BY date
    `).all(startDate, endDate);
  } catch (e) {
    // site_events tablosu henuz olusmadiginda hata vermesin
  }

  res.render('admin/analytics', {
    kpi, statusBreakdown, dailyData, hourlyData, weekdayData,
    cityData, paymentData, topProducts, categoryData,
    abandonedStats, recentAbandoned, orderValueBuckets,
    repeatCustomers, sizeData, liveStats,
    persistentFunnel, deviceFunnel, topDropoffPages, userJourneys, dailyFunnel,
    startDate, endDate,
    layout: false
  });
});

// Analitik CSV/JSON export
router.get('/analitik/export', (req, res) => {
  const startDate = req.query.baslangic || '2000-01-01';
  const endDate = req.query.bitis || '2099-12-31';
  const type = req.query.type || 'orders';

  if (type === 'orders') {
    const rows = db.prepare(`
      SELECT o.id, o.guest_name as musteri, o.guest_email as email, o.guest_phone as telefon,
        o.city as il, o.district as ilce, o.address as adres,
        o.subtotal as araToplam, o.shipping as kargo, o.discount as indirim, o.total as toplam,
        o.payment_method as odemeYontemi, o.status as durum, o.note as not, o.created_at as tarih
      FROM orders o
      WHERE date(o.created_at) BETWEEN ? AND ?
      ORDER BY o.created_at DESC
    `).all(startDate, endDate);
    res.json(rows);
  } else if (type === 'order_items') {
    const rows = db.prepare(`
      SELECT o.id as siparisId, oi.product_name as urun, oi.size as beden, oi.color as renk,
        oi.price as fiyat, oi.quantity as adet, (oi.price * oi.quantity) as toplam,
        o.guest_name as musteri, o.city as il, o.created_at as tarih
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      WHERE date(o.created_at) BETWEEN ? AND ?
      ORDER BY o.created_at DESC
    `).all(startDate, endDate);
    res.json(rows);
  } else if (type === 'abandoned') {
    const rows = db.prepare(`
      SELECT email, guest_name as musteri, cart_total as sepetTutari,
        CASE WHEN email_sent=1 THEN 'Evet' ELSE 'Hayir' END as mailGonderildi,
        CASE WHEN recovered=1 THEN 'Evet' ELSE 'Hayir' END as kurtarildi,
        created_at as tarih
      FROM abandoned_cart_logs
      WHERE date(created_at) BETWEEN ? AND ?
      ORDER BY created_at DESC
    `).all(startDate, endDate);
    res.json(rows);
  } else if (type === 'products') {
    const rows = db.prepare(`
      SELECT p.name as urun, c.name as kategori, p.price as fiyat, p.sale_price as indirimliFiyat,
        p.stock as stok, COALESCE(s.sold, 0) as satilan, COALESCE(s.revenue, 0) as gelir
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN (
        SELECT oi.product_id, SUM(oi.quantity) as sold, SUM(oi.price * oi.quantity) as revenue
        FROM order_items oi
        JOIN orders o ON oi.order_id = o.id
        WHERE date(o.created_at) BETWEEN ? AND ? AND o.status != 'cancelled'
        GROUP BY oi.product_id
      ) s ON s.product_id = p.id
      WHERE p.is_active = 1
      ORDER BY COALESCE(s.sold, 0) DESC
    `).all(startDate, endDate);
    res.json(rows);
  } else if (type === 'cities') {
    const rows = db.prepare(`
      SELECT city as il, COUNT(*) as siparisAdedi, COALESCE(SUM(total),0) as toplamGelir,
        COALESCE(AVG(total),0) as ortSiparis
      FROM orders
      WHERE date(created_at) BETWEEN ? AND ? AND status != 'cancelled' AND city IS NOT NULL AND city != ''
      GROUP BY city
      ORDER BY siparisAdedi DESC
    `).all(startDate, endDate);
    res.json(rows);
  } else {
    res.json([]);
  }
});

// Settings
// ============ WHATSAPP ============

router.get('/whatsapp', (req, res) => {
  const waData = getDashboardData();
  res.render('admin/whatsapp', { layout: false, ...waData });
});

router.post('/whatsapp/gonderildi', (req, res) => {
  const { type, id, phone } = req.body;
  markAsSent(type, parseInt(id) || 0, phone);
  res.json({ ok: true });
});

// ============ AYARLAR ============

router.get('/ayarlar', (req, res) => {
  res.render('admin/settings', { layout: false });
});

router.post('/ayarlar', (req, res) => {
  const fields = ['site_name', 'site_description', 'phone', 'email', 'address',
    'instagram', 'facebook', 'pinterest', 'free_shipping_limit', 'shipping_cost', 'announcement',
    'meta_pixel_id', 'meta_pixel_active', 'google_analytics_id', 'google_analytics_active',
    'cod_cash_enabled', 'cod_card_enabled', 'cod_fee', 'cod_min_amount', 'card_payment_enabled', 'shopier_pat', 'bank_holder', 'bank_name', 'bank_branch', 'bank_iban',
    'payment_eft_desc', 'payment_eft_note',
    'telegram_bot_token', 'telegram_chat_id',
    'meta_capi_token', 'meta_capi_test_code',
    'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from_name', 'smtp_from_email', 'smtp_secure',
    'abandoned_cart_delay', 'abandoned_cart_subject',
    'abandoned_cart_enabled', 'order_confirmation_enabled', 'shipping_notification_enabled', 'reviews_enabled',
    'wa_contact_enabled', 'wa_contact_number', 'wa_contact_message', 'wa_contact_btn_text',
    'wa_enabled', 'wa_payment_reminder_enabled', 'wa_payment_reminder_delay', 'wa_payment_reminder_message',
    'wa_abandoned_cart_enabled', 'wa_abandoned_cart_delay', 'wa_abandoned_cart_message'];
  const update = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  for (const key of fields) {
    if (req.body[key] !== undefined) update.run(key, req.body[key]);
  }
  // Checkbox'lar gönderilmezse 0 kaydet
  const checkboxFields = ['meta_pixel_active', 'google_analytics_active', 'cod_cash_enabled', 'cod_card_enabled', 'card_payment_enabled',
    'smtp_secure', 'abandoned_cart_enabled', 'order_confirmation_enabled', 'shipping_notification_enabled', 'reviews_enabled', 'wa_contact_enabled',
    'wa_enabled', 'wa_payment_reminder_enabled', 'wa_abandoned_cart_enabled'];
  for (const key of checkboxFields) {
    if (req.body[key] === undefined) update.run(key, '0');
  }
  // Telegram bot token değiştiyse botu yeniden başlat
  if (req.body.telegram_bot_token !== undefined) {
    try { initBot(); } catch (e) { console.error('[Telegram] Restart error:', e.message); }
  }
  // SMTP değiştiyse transporter'ı sıfırla
  try { resetTransporter(); } catch (e) {}
  // Abandoned cart otomasyonunu güncelle
  try {
    if (req.body.abandoned_cart_enabled === '1') startAbandonedCartChecker();
    else stopAbandonedCartChecker();
  } catch (e) {}
  // WhatsApp otomasyonunu güncelle
  try {
    if (req.body.wa_enabled === '1') initWhatsApp();
    else stopWhatsApp();
  } catch (e) {}
  // Cache temizle - ayarlar hemen aktif olsun
  if (req.app.clearSettingsCache) req.app.clearSettingsCache();

  res.redirect('/admin/ayarlar');
});



// ============ MESAJLAR (Chat) ============
router.get('/mesajlar', isAdmin, (req, res) => {
  res.render('admin/chat', { currentPath: '/admin/mesajlar', settings: res.locals.settings || {} });
});

router.get('/chat/api/conversations', isAdmin, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT platform, customer_id,
        MAX(message) as last_message,
        MAX(created_at) as last_time,
        COUNT(*) as message_count
      FROM chat_messages
      GROUP BY platform, customer_id
      ORDER BY MAX(created_at) DESC
    `).all();
    res.json(rows);
  } catch(e) {
    console.error('Chat conversations error:', e.message);
    res.json([]);
  }
});

router.get('/chat/api/messages', isAdmin, (req, res) => {
  try {
    const { customer_id, platform } = req.query;
    if (!customer_id || !platform) return res.json([]);
    const rows = db.prepare(`
      SELECT * FROM chat_messages
      WHERE customer_id = ? AND platform = ?
      ORDER BY created_at ASC
    `).all(customer_id, platform);
    res.json(rows);
  } catch(e) {
    console.error('Chat messages error:', e.message);
    res.json([]);
  }
});

// Chat takeover - Sohbeti devral
router.post('/chat/api/takeover', isAdmin, (req, res) => {
  try {
    const { customer_id, platform } = req.body;
    if (!customer_id || !platform) return res.json({ success: false, error: 'Eksik bilgi' });

    // Create table if not exists
    db.exec(`CREATE TABLE IF NOT EXISTS chat_takeover (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      taken_at DATETIME DEFAULT (datetime('now')),
      released_at DATETIME,
      UNIQUE(platform, customer_id)
    )`);

    // Check if already taken over
    const existing = db.prepare("SELECT id FROM chat_takeover WHERE platform = ? AND customer_id = ? AND released_at IS NULL").get(platform, customer_id);
    if (existing) return res.json({ success: true, already: true });

    // Insert or replace
    db.prepare("INSERT OR REPLACE INTO chat_takeover (platform, customer_id, taken_at, released_at) VALUES (?, ?, datetime('now'), NULL)").run(platform, customer_id);
    res.json({ success: true });
  } catch(e) {
    console.error('Takeover error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// Chat release - Sohbeti birak
router.post('/chat/api/release', isAdmin, (req, res) => {
  try {
    const { customer_id, platform } = req.body;
    if (!customer_id || !platform) return res.json({ success: false, error: 'Eksik bilgi' });

    db.prepare("UPDATE chat_takeover SET released_at = datetime('now') WHERE platform = ? AND customer_id = ? AND released_at IS NULL").run(platform, customer_id);
    res.json({ success: true });
  } catch(e) {
    console.error('Release error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// Check takeover status
router.get('/chat/api/takeover-status', isAdmin, (req, res) => {
  try {
    const { customer_id, platform } = req.query;

    // Create table if not exists
    db.exec(`CREATE TABLE IF NOT EXISTS chat_takeover (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      taken_at DATETIME DEFAULT (datetime('now')),
      released_at DATETIME,
      UNIQUE(platform, customer_id)
    )`);

    if (!customer_id || !platform) return res.json({ taken: false });
    const row = db.prepare("SELECT id FROM chat_takeover WHERE platform = ? AND customer_id = ? AND released_at IS NULL").get(platform, customer_id);
    res.json({ taken: !!row });
  } catch(e) {
    res.json({ taken: false });
  }
});

// Admin send message - WhatsApp or Instagram
router.post('/chat/api/send', isAdmin, async (req, res) => {
  try {
    const { customer_id, platform, message } = req.body;
    if (!customer_id || !platform || !message) return res.json({ success: false, error: 'Eksik bilgi' });

    const axios = require('axios');

    if (platform === 'whatsapp') {
      // Send via WhatsApp API
      const settings = {};
      const keys = ['wa_api_token', 'wa_phone_number_id', 'wa_api_url'];
      const rows = db.prepare("SELECT key, value FROM settings WHERE key IN ('wa_api_token','wa_phone_number_id','wa_api_url')").all();
      for (const r of rows) settings[r.key] = r.value;

      const token = settings.wa_api_token;
      const phoneNumberId = settings.wa_phone_number_id;
      const apiUrl = settings.wa_api_url || 'https://graph.facebook.com/v21.0';

      await axios.post(`${apiUrl}/${phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        to: customer_id,
        type: 'text',
        text: { body: message }
      }, {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
      });

    } else if (platform === 'instagram') {
      // Send via Instagram API (graph.instagram.com kullaniliyor)
      const igTokenRow = db.prepare("SELECT value FROM settings WHERE key = 'instagram_page_access_token'").get();
      const igToken = (igTokenRow && igTokenRow.value) || 'IGAALbC6EGnNtBZAGJWeEdUbHNVb3ZAsSk1wdEdNQXdFLU50R0tIZAmVTX093eDFQYVFJX2JiUUNmcm12c21XZAVdvaXdXSVdmWE9MazI1ZAUdxM05sMEtiZAHE2ZA0tCSHdIV0pTWnZA5NjlMREllM05wTTJkMlNfVzFrM2JuS0NKcjc2ZAwZDZD';

      await axios.post('https://graph.instagram.com/v21.0/me/messages', {
        recipient: { id: customer_id },
        message: { text: message }
      }, {
        headers: { 'Authorization': `Bearer ${igToken}`, 'Content-Type': 'application/json' }
      });
    }

    // Save to chat_messages
    db.prepare("INSERT INTO chat_messages (platform, customer_id, direction, message) VALUES (?, ?, 'outgoing', ?)").run(platform, customer_id, message);

    res.json({ success: true });
  } catch(e) {
    const errData = e.response && e.response.data ? JSON.stringify(e.response.data) : e.message;
    console.error('Send message error:', errData);
    res.json({ success: false, error: e.response && e.response.data && e.response.data.error ? e.response.data.error.message : e.message });
  }
});


// ============ BOT TOGGLE ============
router.get('/chat/api/bot-status', isAdmin, (req, res) => {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'chatbot_active'").get();
    res.json({ active: row ? row.value === '1' : true });
  } catch(e) {
    res.json({ active: true });
  }
});

router.post('/chat/api/bot-toggle', isAdmin, (req, res) => {
  try {
    const { active } = req.body;
    const val = active ? '1' : '0';
    const existing = db.prepare("SELECT value FROM settings WHERE key = 'chatbot_active'").get();
    if (existing) {
      db.prepare("UPDATE settings SET value = ? WHERE key = 'chatbot_active'").run(val);
    } else {
      db.prepare("INSERT INTO settings (key, value) VALUES ('chatbot_active', ?)").run(val);
    }
    res.json({ success: true, active: active });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

// ============ CHATBOT KURALLARI ============
router.get('/chatbot-kurallari', isAdmin, (req, res) => {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'ai_rules'").get();
    const aiRules = row ? row.value : getDefaultAiRules();
    res.render('admin/chatbot-rules', {
      currentPath: '/admin/chatbot-kurallari',
      settings: res.locals.settings || {},
      aiRules: aiRules
    });
  } catch(e) {
    console.error('Chatbot rules error:', e.message);
    res.render('admin/chatbot-rules', {
      currentPath: '/admin/chatbot-kurallari',
      settings: res.locals.settings || {},
      aiRules: ''
    });
  }
});

router.post('/chatbot-kurallari/kaydet', isAdmin, (req, res) => {
  try {
    const { rules } = req.body;
    if (!rules || rules.trim().length < 10) return res.json({ success: false, error: 'Kurallar cok kisa' });

    const existing = db.prepare("SELECT value FROM settings WHERE key = 'ai_rules'").get();
    if (existing) {
      db.prepare("UPDATE settings SET value = ? WHERE key = 'ai_rules'").run(rules);
    } else {
      db.prepare("INSERT INTO settings (key, value) VALUES ('ai_rules', ?)").run(rules);
    }
    res.json({ success: true });
  } catch(e) {
    console.error('Save rules error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

router.post('/chatbot-kurallari/sifirla', isAdmin, (req, res) => {
  try {
    db.prepare("DELETE FROM settings WHERE key = 'ai_rules'").run();
    res.json({ success: true, rules: getDefaultAiRules() });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

function getDefaultAiRules() {
  return `Sen Modaflavora butik magazasinin musteri temsilcisisin. Adin "Modaflavora Asistan".
Musteri sana yazdiginda sen Modaflavora magazasinin gercek bir calisani gibi cevap veriyorsun.
WhatsApp ve Instagram uzerinden musterilere yardimci oluyorsun.

## GENEL KURALLAR
- Yapay zeka oldugunu SOYLEME, kendini Modaflavora musteri temsilcisi olarak tanit
- Aktif bir konusmada musteriye tekrar "Merhaba! Nasil yardimci olabilirim?" deme, konudan devam et
- Musteriye "urun ID'si" veya teknik terim sorma; urun adini netlestirmesini iste

## USLUP
- Profesyonel, guler yuzlu, butik danismani gibi yanit ver
- Musteriye "siz" diye hitap et
- Kisa ve oz (2-6 satir), olculu emoji
- Musteri sinirlendiginde sakin kal, savunmaya gecme

## URUN BILGISI
- SADECE katalogdaki urun bilgilerini kullan, fiyat veya ozellik UYDURMA
- Urun bulundugunda fiyat + link paylas
- Birden fazla eslesme varsa en alakali 3-5 tanesini listele

## MANKEN BILGILERI
- Boy: 168cm, Kilo: 60kg, Beden: Medium
- Bu bilgi TUM urunler icin gecerlidir

## ODEME
- Havale / EFT / FAST
- Banka Hesap Bilgileri:
  Hesap Sahibi: {{HESAP_SAHIBI}}
  Banka: {{BANKA}}
  IBAN: {{IBAN}}

## YASAKLAR
- Katalog disi urun bilgisi verme
- Fiyat veya olcu uydurma
- Bot veya yapay zeka oldugunu soyleme`;
}

module.exports = router;
