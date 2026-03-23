const express = require('express');
const router = express.Router();
const { initBot } = require('../telegram');
const { resetTransporter, sendMail } = require('../mailer');
const { startAbandonedCartChecker, stopAbandonedCartChecker } = require('../abandoned-cart');
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
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, req.params.id);

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

// Settings
router.get('/ayarlar', (req, res) => {
  res.render('admin/settings', { layout: false });
});

router.post('/ayarlar', (req, res) => {
  const fields = ['site_name', 'site_description', 'phone', 'email', 'address',
    'instagram', 'facebook', 'pinterest', 'free_shipping_limit', 'shipping_cost', 'announcement',
    'meta_pixel_id', 'meta_pixel_active', 'google_analytics_id', 'google_analytics_active',
    'cod_enabled', 'bank_holder', 'bank_name', 'bank_branch', 'bank_iban',
    'payment_eft_desc', 'payment_eft_note',
    'telegram_bot_token', 'telegram_chat_id',
    'meta_capi_token', 'meta_capi_test_code',
    'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from_name', 'smtp_from_email', 'smtp_secure',
    'abandoned_cart_delay', 'abandoned_cart_subject',
    'abandoned_cart_enabled', 'order_confirmation_enabled', 'shipping_notification_enabled'];
  const update = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  for (const key of fields) {
    if (req.body[key] !== undefined) update.run(key, req.body[key]);
  }
  // Checkbox'lar gönderilmezse 0 kaydet
  const checkboxFields = ['meta_pixel_active', 'google_analytics_active', 'cod_enabled',
    'smtp_secure', 'abandoned_cart_enabled', 'order_confirmation_enabled', 'shipping_notification_enabled'];
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
  res.redirect('/admin/ayarlar');
});

module.exports = router;
