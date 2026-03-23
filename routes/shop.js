const express = require('express');
const router = express.Router();
const { db, getSettings } = require('../database');
const { isAuthenticated } = require('../middleware/auth');
const { sendOrderNotification } = require('../telegram');
const { trackEvent } = require('../tracker');
const capi = require('../meta-capi');
const { sendMail, orderConfirmationEmail } = require('../mailer');
const { logCheckoutVisit, markCartRecovered } = require('../abandoned-cart');
const DISTRICTS_DATA = require('../districts-data');

// Homepage
router.get('/', (req, res) => {
  const categories = db.prepare(
    'SELECT * FROM categories WHERE parent_id IS NULL AND is_active = 1 ORDER BY sort_order LIMIT 6'
  ).all();

  const newProducts = db.prepare(
    'SELECT * FROM products WHERE is_active = 1 AND is_new = 1 ORDER BY created_at DESC LIMIT 8'
  ).all();

  const featuredProducts = db.prepare(
    'SELECT * FROM products WHERE is_active = 1 AND is_featured = 1 ORDER BY created_at DESC LIMIT 8'
  ).all();

  const saleProducts = db.prepare(
    'SELECT * FROM products WHERE is_active = 1 AND sale_price IS NOT NULL AND sale_price > 0 ORDER BY created_at DESC LIMIT 8'
  ).all();

  const sliders = db.prepare(
    'SELECT * FROM sliders WHERE is_active = 1 ORDER BY sort_order'
  ).all();

  const allCategories = db.prepare(
    'SELECT * FROM categories WHERE is_active = 1 ORDER BY sort_order'
  ).all();

  const settings = getSettings();
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.render('index', {
    categories, allCategories, newProducts, featuredProducts, saleProducts, sliders,
    seoTitle: `${settings.site_name} | ${settings.site_description}`,
    seoDescription: `${settings.site_name} - Online kadın giyim mağazası. Elbise, bluz, etek, pantolon ve daha fazlası uygun fiyatlarla. ${settings.free_shipping_limit}₺ üzeri ücretsiz kargo.`,
    seoCanonical: baseUrl + '/',
    seoImage: sliders.length > 0 && sliders[0].image ? baseUrl + sliders[0].image : ''
  });
});

// Products listing
function buildProductQuery(query) {
  const { kategori, siralama, ara, indirim } = query;
  let where = 'WHERE p.is_active = 1';
  const params = [];

  if (indirim) where += ' AND p.sale_price IS NOT NULL AND p.sale_price > 0 AND p.sale_price < p.price';

  if (kategori) {
    const cat = db.prepare('SELECT id FROM categories WHERE slug = ?').get(kategori);
    if (cat) {
      const childCats = db.prepare('SELECT id FROM categories WHERE parent_id = ?').all(cat.id);
      const catIds = [cat.id, ...childCats.map(c => c.id)];
      where += ` AND p.category_id IN (${catIds.map(() => '?').join(',')})`;
      params.push(...catIds);
    }
  }

  if (ara) { where += ' AND p.name LIKE ?'; params.push(`%${ara}%`); }

  let orderBy = 'ORDER BY p.created_at DESC';
  if (siralama === 'fiyat-artan') orderBy = 'ORDER BY COALESCE(p.sale_price, p.price) ASC';
  if (siralama === 'fiyat-azalan') orderBy = 'ORDER BY COALESCE(p.sale_price, p.price) DESC';
  if (siralama === 'yeni') orderBy = 'ORDER BY p.created_at DESC';
  if (siralama === 'populer') orderBy = 'ORDER BY p.is_featured DESC, p.created_at DESC';

  return { where, params, orderBy };
}

router.get('/urunler', (req, res) => {
  const limit = 24;
  const page = parseInt(req.query.sayfa) || 1;
  const offset = (page - 1) * limit;
  const { where, params, orderBy } = buildProductQuery(req.query);

  // JSON modu: infinite scroll için
  if (req.query._json) {
    const products = db.prepare(
      `SELECT p.id, p.name, p.slug, p.image, p.price, p.sale_price, p.is_new, p.is_featured
       FROM products p LEFT JOIN categories c ON p.category_id = c.id
       ${where} ${orderBy} LIMIT ? OFFSET ?`
    ).all(...params, limit, offset);
    const total = db.prepare(`SELECT COUNT(*) as count FROM products p ${where}`).get(...params).count;
    return res.json({ products, hasMore: offset + products.length < total, total });
  }

  const total = db.prepare(`SELECT COUNT(*) as count FROM products p ${where}`).get(...params).count;
  const products = db.prepare(
    `SELECT p.*, c.name as category_name FROM products p
     LEFT JOIN categories c ON p.category_id = c.id
     ${where} ${orderBy} LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  const categories = db.prepare('SELECT * FROM categories WHERE is_active = 1 ORDER BY sort_order').all();
  const currentCategory = req.query.kategori
    ? db.prepare('SELECT * FROM categories WHERE slug = ?').get(req.query.kategori)
    : null;

  const settings = getSettings();
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const isIndirim = !!req.query.indirim;
  const catName = currentCategory ? currentCategory.name : (isIndirim ? 'İndirimli Ürünler' : 'Tüm Ürünler');
  const seoTitle = `${catName} | ${settings.site_name}`;
  const seoDesc = currentCategory
    ? `${currentCategory.name} kategorisinde ${total} ürün. ${settings.site_name}'da uygun fiyat ve ${settings.free_shipping_limit}₺ üzeri ücretsiz kargo.`
    : isIndirim
    ? `İndirimli ürünlerde ${total} fırsat. ${settings.site_name}'da kampanyalı ürünleri keşfedin.`
    : `${settings.site_name}'da ${total} ürün. Kadın giyim, elbise, bluz, etek ve daha fazlası.`;
  let canonicalUrl = baseUrl + '/urunler';
  if (req.query.kategori) canonicalUrl += '?kategori=' + req.query.kategori;
  else if (isIndirim) canonicalUrl += '?indirim=1';

  res.render('products', {
    products, categories, currentCategory, total,
    query: req.query, isIndirim,
    hasMore: products.length < total,
    seoTitle, seoDescription: seoDesc, seoCanonical: canonicalUrl
  });
});

// Product detail
router.get('/urun/:slug', (req, res) => {
  const product = db.prepare(
    `SELECT p.*, c.name as category_name, c.slug as category_slug
     FROM products p LEFT JOIN categories c ON p.category_id = c.id
     WHERE p.slug = ? AND p.is_active = 1`
  ).get(req.params.slug);

  if (!product) return res.status(404).render('404');

  const relatedProducts = db.prepare(
    `SELECT * FROM products WHERE category_id = ? AND id != ? AND is_active = 1
     ORDER BY RANDOM() LIMIT 4`
  ).all(product.category_id, product.id);

  let isFavorited = false;
  if (req.session.user) {
    isFavorited = !!db.prepare(
      'SELECT id FROM favorites WHERE user_id = ? AND product_id = ?'
    ).get(req.session.user.id, product.id);
  }

  // Renk varyantları (aynı ürünün diğer renkleri)
  let colorVariants = [];
  if (product.color_group) {
    colorVariants = db.prepare(
      `SELECT id, name, slug, image, color_name
       FROM products WHERE color_group = ? AND is_active = 1
       ORDER BY color_name ASC`
    ).all(product.color_group);
  }

  // Yorumlar
  const reviews = db.prepare(
    'SELECT * FROM reviews WHERE product_id = ? AND is_approved = 1 ORDER BY created_at DESC'
  ).all(product.id);
  const reviewStats = db.prepare(
    `SELECT COUNT(*) as count, AVG(rating) as avg,
     SUM(CASE WHEN rating=5 THEN 1 ELSE 0 END) as r5,
     SUM(CASE WHEN rating=4 THEN 1 ELSE 0 END) as r4,
     SUM(CASE WHEN rating=3 THEN 1 ELSE 0 END) as r3,
     SUM(CASE WHEN rating=2 THEN 1 ELSE 0 END) as r2,
     SUM(CASE WHEN rating=1 THEN 1 ELSE 0 END) as r1
     FROM reviews WHERE product_id = ? AND is_approved = 1`
  ).get(product.id);

  // Meta CAPI: ViewContent
  try { capi.trackViewContent(req, product); } catch (e) {}

  const settings = getSettings();
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const price = product.sale_price && product.sale_price < product.price ? product.sale_price : product.price;
  const seoTitle = `${product.name} | ${settings.site_name}`;
  const descText = product.description ? product.description.replace(/<[^>]*>/g, '').substring(0, 150) : '';
  const seoDesc = descText || `${product.name} - ${product.category_name || 'Kadın Giyim'}. ${price.toLocaleString('tr-TR')}₺. ${settings.site_name}'da ücretsiz kargo fırsatı.`;

  res.render('product-detail', {
    product, relatedProducts, isFavorited, colorVariants, reviews, reviewStats,
    seoTitle,
    seoDescription: seoDesc,
    seoCanonical: baseUrl + '/urun/' + product.slug,
    seoImage: product.image ? baseUrl + product.image : '',
    seoPrice: price,
    seoType: 'product'
  });
});

// Cart
router.get('/sepet', (req, res) => {
  res.render('cart');
});

// Checkout (/siparis veya /odeme)
router.get('/siparis', (req, res) => {
  if (!req.session.cart || req.session.cart.length === 0) {
    return res.redirect('/sepet');
  }
  trackEvent('checkout');
  try { capi.trackInitiateCheckout(req, req.session.cart); } catch (e) {}
  const districtsJSON = JSON.stringify(DISTRICTS_DATA);
  res.render('checkout', { districtsJSON });
});
router.get('/odeme', (req, res) => res.redirect('/siparis'));

router.post('/siparis', (req, res) => {
  const cart = req.session.cart || [];
  if (cart.length === 0) return res.redirect('/sepet');

  const { name, email, phone, address, city, district, zip_code, note, payment_method } = req.body;

  // Abandoned cart: checkout'a e-posta ile ulaşanları logla
  if (email) {
    req.session.checkoutEmail = email;
    req.session.checkoutName = name;
    req.session.checkoutPhone = phone;
    try { logCheckoutVisit(req); } catch (e) {}
  }
  const settings = getSettings();

  const subtotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const freeShippingLimit = parseFloat(settings.free_shipping_limit) || 2000;
  const shippingCost = subtotal >= freeShippingLimit ? 0 : parseFloat(settings.shipping_cost) || 49.90;
  const total = subtotal + shippingCost;

  const pm = payment_method || 'eft';
  const initialStatus = pm === 'eft' ? 'pending_payment' : 'pending';

  const result = db.prepare(
    `INSERT INTO orders (user_id, guest_name, guest_email, guest_phone, address, city, district, zip_code, note, subtotal, shipping, total, payment_method, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    req.session.user ? req.session.user.id : null,
    name, email, phone, address, city, district || '', zip_code || '', note || '',
    subtotal, shippingCost, total, pm, initialStatus
  );

  const orderId = result.lastInsertRowid;
  const insertItem = db.prepare(
    `INSERT INTO order_items (order_id, product_id, product_name, product_image, price, quantity, size, color)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const item of cart) {
    insertItem.run(orderId, item.productId, item.name, item.image, item.price, item.quantity, item.size, item.color);
  }

  // Event tracking, CAPI & Telegram bildirim
  trackEvent('order', total);
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    const orderItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
    capi.trackPurchase(req, order, orderItems);
  } catch (e) {}
  try { sendOrderNotification(orderId); } catch (e) { console.error('[Telegram]', e.message); }

  // Sipariş onay maili
  if (settings.order_confirmation_enabled === '1' && email) {
    try {
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
      const orderItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
      sendMail({ to: email, subject: `Sipariş Onayı #${orderId} — ${settings.site_name || 'FLAVORA'}`, html: orderConfirmationEmail(order, orderItems, settings) });
    } catch (e) { console.error('[Mail] Order confirmation:', e.message); }
  }

  // Terk edilen sepet kaydını recovered yap
  try { markCartRecovered(email); } catch (e) {}

  req.session.cart = [];
  if (pm === 'cod') {
    // Kapıda ödeme: doğrudan tebrikler sayfasına
    res.redirect('/siparis/tebrikler?id=' + orderId);
  } else {
    // EFT: ödeme bekleme sayfasına
    req.session.lastOrder = { orderId, total, paymentMethod: pm };
    res.redirect('/siparis/tamamlandi');
  }
});

// Order success page (GET - refresh-safe)
router.get('/siparis/tamamlandi', (req, res) => {
  const last = req.session.lastOrder;
  if (!last) return res.redirect('/');
  const { orderId, total, paymentMethod } = last;
  const settings = getSettings();
  res.render('order-success', { orderId, total, paymentMethod, settings });
});

// Tebrikler (ödeme onaylandıktan sonra - Meta event tracking için ayrı sayfa)
router.get('/siparis/tebrikler', (req, res) => {
  const orderId = req.query.id;
  if (!orderId) return res.redirect('/');
  const order = db.prepare(
    'SELECT id, total, payment_method, status FROM orders WHERE id = ?'
  ).get(orderId);
  if (!order) return res.redirect('/');

  // Sipariş kalemlerini al
  const items = db.prepare(
    'SELECT product_name, price, quantity FROM order_items WHERE order_id = ?'
  ).all(orderId);

  const settings = getSettings();
  res.render('order-thankyou', { order, items, settings });
});

// Favorites
router.get('/favoriler', isAuthenticated, (req, res) => {
  const favorites = db.prepare(
    `SELECT p.* FROM products p
     INNER JOIN favorites f ON f.product_id = p.id
     WHERE f.user_id = ? AND p.is_active = 1
     ORDER BY f.created_at DESC`
  ).all(req.session.user.id);
  res.render('favorites', { products: favorites });
});

// My orders
router.get('/siparislerim', isAuthenticated, (req, res) => {
  const orders = db.prepare(
    'SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC'
  ).all(req.session.user.id);
  res.render('my-orders', { orders });
});

// Sitemap.xml
router.get('/sitemap.xml', (req, res) => {
  const settings = getSettings();
  const baseUrl = settings.site_url || `${req.protocol}://${req.get('host')}`;
  const now = new Date().toISOString().split('T')[0];

  const products = db.prepare(
    "SELECT slug, created_at FROM products WHERE is_active = 1 ORDER BY created_at DESC"
  ).all();

  const categories = db.prepare(
    "SELECT slug FROM categories WHERE is_active = 1 ORDER BY sort_order"
  ).all();

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url>
    <loc>${baseUrl}/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
    <lastmod>${now}</lastmod>
  </url>
  <url>
    <loc>${baseUrl}/urunler</loc>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>${baseUrl}/urunler?indirim=1</loc>
    <changefreq>daily</changefreq>
    <priority>0.8</priority>
  </url>`;

  categories.forEach(cat => {
    xml += `
  <url>
    <loc>${baseUrl}/urunler?kategori=${cat.slug}</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`;
  });

  products.forEach(p => {
    const date = p.created_at ? p.created_at.split(' ')[0] : now;
    xml += `
  <url>
    <loc>${baseUrl}/urun/${p.slug}</loc>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
    <lastmod>${date}</lastmod>
  </url>`;
  });

  xml += '\n</urlset>';

  res.set('Content-Type', 'application/xml');
  res.send(xml);
});

module.exports = router;
