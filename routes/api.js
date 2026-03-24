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
  try { capi.trackAddToCart(req, product); } catch (e) {}
  const itemPrice = product.sale_price || product.price;
  res.json({
    success: true, cartCount, cartTotal,
    message: 'Ürün sepete eklendi',
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

module.exports = router;
