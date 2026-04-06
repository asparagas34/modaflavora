const express = require('express');
const router = express.Router();
const { db, getSettings } = require('../database');
const { sendOrderNotification } = require('../telegram');
const shopierCheckout = require('../shopier-checkout');
const capi = require('../meta-capi');

/**
 * POST /shopier/osb — Shopier Otomatik Sipariş Bildirimi webhook
 * Called by Shopier when a payment is completed on their platform
 */
router.post('/osb', (req, res) => {
  try {
    const data = shopierCheckout.parseOSBData(req.body);
    console.log('[Shopier OSB] Received:', JSON.stringify(data));

    // Find our order by the shopier product ID stored in payment_token
    // payment_token format: "shopier:{shopierProductId}"
    const orders = db.prepare(
      "SELECT * FROM orders WHERE payment_token LIKE 'shopier:%' AND payment_method = 'card' AND status = 'pending_payment'"
    ).all();

    if (!orders.length) {
      console.log('[Shopier OSB] No matching pending card orders found');
      return res.json({ status: 'ok', message: 'no matching order' });
    }

    // Try to match by looking at the Shopier order details
    // The platformOrderId from OSB should help us match
    let matchedOrder = null;

    // If we have a platform_order_id, try to match product name "Sipariş #XXXX"
    // For now, match the most recent pending_payment card order
    // TODO: Improve matching by storing shopier_order_id during checkout
    matchedOrder = orders[orders.length - 1];

    if (data.status === '1' || data.status === 1) {
      // Payment successful
      db.prepare("UPDATE orders SET status = 'pending' WHERE id = ?").run(matchedOrder.id);
      console.log('[Shopier OSB] Order #' + matchedOrder.id + ' payment confirmed');

      // Send Telegram notification
      try { sendOrderNotification(matchedOrder.id); } catch (e) {}

      // Track purchase event
      try {
        const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(matchedOrder.id);
        const orderItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(matchedOrder.id);
        capi.trackPurchase(null, order, orderItems);
      } catch (e) {}

      // Clean up temporary Shopier product
      const token = matchedOrder.payment_token;
      if (token && token.startsWith('shopier:')) {
        const shopierProductId = token.replace('shopier:', '');
        shopierCheckout.deletePaymentProduct(shopierProductId).catch(() => {});
      }
    } else {
      // Payment failed
      db.prepare("UPDATE orders SET status = 'payment_failed' WHERE id = ?").run(matchedOrder.id);
      console.log('[Shopier OSB] Order #' + matchedOrder.id + ' payment failed');
    }

    res.json({ status: 'ok' });
  } catch (err) {
    console.error('[Shopier OSB] Error:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * GET /shopier/odeme-durumu/:orderId — Check payment status (polling endpoint)
 * Frontend can poll this to check if payment was completed
 */
router.get('/odeme-durumu/:orderId', (req, res) => {
  const order = db.prepare('SELECT id, status, payment_method FROM orders WHERE id = ?').get(req.params.orderId);
  if (!order) return res.json({ status: 'not_found' });

  res.json({
    orderId: order.id,
    status: order.status,
    paid: order.status !== 'pending_payment' && order.status !== 'payment_failed'
  });
});

module.exports = router;
