const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { trackEvent } = require('../tracker');
const capi = require('../meta-capi');

// Add to cart
router.post('/cart/add', (req, res) => {
  const { productId, size, color, quantity } = req.body;
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND is_active = 1').get(productId);
  if (!product) return res.json({ success: false, message: 'Ürün bulunamadı' });

  if (!req.session.cart) req.session.cart = [];

  const existingIndex = req.session.cart.findIndex(
    item => item.productId === productId && item.size === size && item.color === color
  );

  if (existingIndex > -1) {
    req.session.cart[existingIndex].quantity += (quantity || 1);
  } else {
    req.session.cart.push({
      productId,
      name: product.name,
      price: product.sale_price || product.price,
      originalPrice: product.price,
      image: product.image,
      size: size || '',
      color: color || '',
      quantity: quantity || 1,
      slug: product.slug
    });
  }

  const cartCount = req.session.cart.reduce((sum, item) => sum + item.quantity, 0);
  const cartTotal = req.session.cart.reduce((sum, item) => sum + item.price * item.quantity, 0);

  trackEvent('cart_add', 0, req);
  const atcEventId = `atc_${product.id}_${Date.now()}`;
  try { capi.trackAddToCart(req, product, atcEventId); } catch (e) {}
  const itemPrice = product.sale_price || product.price;
  res.json({
    success: true, cartCount, cartTotal,
    message: 'Ürün sepete eklendi',
    atcEventId,
    product: { id: product.id, name: product.name, price: itemPrice, category: product.category_id }
  });
});

// Update cart
router.post('/cart/update', (req, res) => {
  const { index, quantity } = req.body;
  if (!req.session.cart || !req.session.cart[index]) {
    return res.json({ success: false });
  }

  if (quantity <= 0) {
    req.session.cart.splice(index, 1);
  } else {
    req.session.cart[index].quantity = quantity;
  }

  const cartCount = req.session.cart.reduce((sum, item) => sum + item.quantity, 0);
  const cartTotal = req.session.cart.reduce((sum, item) => sum + item.price * item.quantity, 0);

  res.json({ success: true, cartCount, cartTotal });
});

// Remove from cart
router.post('/cart/remove', (req, res) => {
  const { index } = req.body;
  if (req.session.cart) {
    req.session.cart.splice(index, 1);
  }
  const cartCount = (req.session.cart || []).reduce((sum, item) => sum + item.quantity, 0);
  const cartTotal = (req.session.cart || []).reduce((sum, item) => sum + item.price * item.quantity, 0);
  res.json({ success: true, cartCount, cartTotal });
});

// Cart data (for drawer)
router.get('/cart/data', (req, res) => {
  const cart = req.session.cart || [];
  const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  res.json({ items: cart, total, count: cart.reduce((s, i) => s + i.quantity, 0) });
});

// Search
router.get('/search', (req, res) => {
  const q = req.query.q || '';
  if (q.length < 2) return res.json([]);
  const products = db.prepare(
    `SELECT id, name, slug, price, sale_price, image FROM products
     WHERE is_active = 1 AND name LIKE ? LIMIT 8`
  ).all(`%${q}%`);
  res.json(products);
});

// Order status check (for payment confirmation polling)
router.get('/order/status/:id', (req, res) => {
  const order = db.prepare('SELECT id, status, payment_method FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.json({ success: false });
  const labels = {
    pending_payment: 'Ödeme Bekleniyor',
    pending: 'Beklemede',
    processing: 'Ödeme Onaylandı',
    shipped: 'Kargoda',
    delivered: 'Teslim Edildi',
    cancelled: 'İptal'
  };
  res.json({ success: true, status: order.status, label: labels[order.status] || order.status, confirmed: order.status !== 'pending_payment' && order.status !== 'cancelled' });
});

// Toggle favorite
router.post('/favorite/toggle', (req, res) => {
  if (!req.session.user) return res.json({ success: false, message: 'Giriş yapmalısınız' });
  const { productId } = req.body;
  const existing = db.prepare('SELECT id FROM favorites WHERE user_id = ? AND product_id = ?')
    .get(req.session.user.id, productId);

  if (existing) {
    db.prepare('DELETE FROM favorites WHERE id = ?').run(existing.id);
    res.json({ success: true, favorited: false });
  } else {
    db.prepare('INSERT INTO favorites (user_id, product_id) VALUES (?, ?)').run(req.session.user.id, productId);
    res.json({ success: true, favorited: true });
  }
});

// Submit review
router.post('/review', (req, res) => {
  const { productId, name, city, rating, title, comment } = req.body;
  if (!productId || !name || !comment) {
    return res.json({ success: false, message: 'Ad ve yorum zorunludur' });
  }
  const r = Math.min(5, Math.max(1, parseInt(rating) || 5));
  db.prepare(
    'INSERT INTO reviews (product_id, author_name, author_city, rating, title, comment, is_verified, is_approved) VALUES (?, ?, ?, ?, ?, ?, 0, 0)'
  ).run(productId, name.trim(), city?.trim() || '', r, title?.trim() || '', comment.trim());
  res.json({ success: true, message: 'Yorumunuz gönderildi! Onaylandıktan sonra yayınlanacak.' });
});

// Helpful review
router.post('/review/helpful', (req, res) => {
  const { reviewId } = req.body;
  if (!reviewId) return res.json({ success: false });
  db.prepare('UPDATE reviews SET helpful_count = helpful_count + 1 WHERE id = ?').run(reviewId);
  res.json({ success: true });
});

// ============ META URUN FEED (Ticaret Yoneticisi) ============

/**
 * CSV feed: https://modaflavora.com/api/feed/meta.csv
 * XML feed: https://modaflavora.com/api/feed/meta.xml
 *
 * Meta Commerce Manager'da URL olarak ekleyin, otomatik senkron olur.
 */

// CSV Feed
router.get('/feed/meta.csv', (req, res) => {
  const { getSettings } = require('../database');
  const settings = getSettings();
  const siteUrl = 'https://modaflavora.com';
  const brand = settings.site_name || 'FLAVORA';

  const products = db.prepare(`
    SELECT p.*, c.name as category_name
    FROM products p
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE p.is_active = 1
  `).all();

  const headers = ['id','title','description','availability','condition','price','sale_price','link','image_link','additional_image_link','brand','google_product_category','product_type','inventory','status'];

  let csv = headers.join('\t') + '\n';

  for (const p of products) {
    const price = p.price ? p.price.toFixed(2) + ' TRY' : '';
    const salePrice = (p.sale_price && p.sale_price < p.price) ? p.sale_price.toFixed(2) + ' TRY' : '';
    const link = `${siteUrl}/urun/${p.slug}`;
    const imageLink = p.image ? `${siteUrl}${p.image}` : '';

    // Ek gorseller
    let additionalImages = '';
    try {
      if (p.images) {
        const imgs = JSON.parse(p.images);
        additionalImages = imgs.slice(0, 10).map(img => `${siteUrl}${img}`).join(',');
      }
    } catch (e) {}

    const desc = (p.description || p.name || '').replace(/[\t\n\r]/g, ' ').replace(/<[^>]*>/g, '').substring(0, 5000);
    const title = (p.name || '').replace(/[\t\n\r]/g, ' ');

    const row = [
      p.id,
      title,
      desc,
      'in stock',
      'new',
      price,
      salePrice,
      link,
      imageLink,
      additionalImages,
      brand,
      '2271',  // Clothing & Accessories > Clothing
      p.category_name || 'Giyim',
      '',
      'active'
    ];

    csv += row.map(v => String(v || '').replace(/\t/g, ' ')).join('\t') + '\n';
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="meta-product-feed.csv"');
  res.send(csv);
});

// XML/RSS Feed
router.get('/feed/meta.xml', (req, res) => {
  const { getSettings } = require('../database');
  const settings = getSettings();
  const siteUrl = 'https://modaflavora.com';
  const brand = settings.site_name || 'FLAVORA';

  const products = db.prepare(`
    SELECT p.*, c.name as category_name
    FROM products p
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE p.is_active = 1
  `).all();

  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
<channel>
<title>${esc(brand)} - Urun Katalogu</title>
<link>${siteUrl}</link>
<description>${esc(settings.site_description || '')}</description>
`;

  for (const p of products) {
    const price = p.price ? p.price.toFixed(2) + ' TRY' : '';
    const salePrice = (p.sale_price && p.sale_price < p.price) ? p.sale_price.toFixed(2) + ' TRY' : '';
    const link = `${siteUrl}/urun/${p.slug}`;
    const imageLink = p.image ? `${siteUrl}${p.image}` : '';
    const desc = (p.description || p.name || '').replace(/<[^>]*>/g, '').substring(0, 5000);

    xml += `<item>
<g:id>${p.id}</g:id>
<g:title>${esc(p.name)}</g:title>
<g:description>${esc(desc)}</g:description>
<g:link>${esc(link)}</g:link>
<g:image_link>${esc(imageLink)}</g:image_link>
`;

    // Ek gorseller
    try {
      if (p.images) {
        const imgs = JSON.parse(p.images);
        imgs.slice(0, 10).forEach(img => {
          xml += `<g:additional_image_link>${esc(siteUrl + img)}</g:additional_image_link>\n`;
        });
      }
    } catch (e) {}

    xml += `<g:availability>in stock</g:availability>
<g:condition>new</g:condition>
<g:price>${price}</g:price>
`;
    if (salePrice) xml += `<g:sale_price>${salePrice}</g:sale_price>\n`;

    xml += `<g:brand>${esc(brand)}</g:brand>
<g:google_product_category>2271</g:google_product_category>
<g:product_type>${esc(p.category_name || 'Giyim')}</g:product_type>
</item>
`;
  }

  xml += `</channel>\n</rss>`;

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.send(xml);
});

module.exports = router;
