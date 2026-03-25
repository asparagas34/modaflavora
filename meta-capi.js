/**
 * Meta Conversions API (CAPI) - Server-Side Event Tracking
 * https://developers.facebook.com/docs/marketing-api/conversions-api
 */

const https = require('https');
const crypto = require('crypto');
const { getSettings } = require('./database');

const API_VERSION = 'v18.0';
const GRAPH_URL = 'graph.facebook.com';

/**
 * SHA256 hash (Meta CAPI requires hashed PII)
 */
function hash(value) {
  if (!value) return undefined;
  return crypto.createHash('sha256').update(value.toString().trim().toLowerCase()).digest('hex');
}

/**
 * Send event to Meta Conversions API
 * @param {string} eventName - 'Purchase', 'AddToCart', 'InitiateCheckout', 'ViewContent', 'PageView'
 * @param {object} params - { req, userData, customData, eventId }
 */
function sendEvent(eventName, params = {}) {
  const settings = getSettings();
  const pixelId = settings.meta_pixel_id;
  const accessToken = settings.meta_capi_token;

  if (!pixelId || !accessToken || settings.meta_pixel_active !== '1') return;

  const { req, userData = {}, customData = {}, eventId } = params;

  // User data (hashed for privacy)
  const ud = {};
  if (userData.email) ud.em = [hash(userData.email)];
  if (userData.phone) ud.ph = [hash(userData.phone.replace(/\D/g, ''))];
  if (userData.firstName) ud.fn = [hash(userData.firstName)];
  if (userData.lastName) ud.ln = [hash(userData.lastName)];
  if (userData.city) ud.ct = [hash(userData.city)];
  if (userData.zipCode) ud.zp = [hash(userData.zipCode)];
  ud.country = [hash('tr')];

  // Client info from request
  if (req) {
    ud.client_ip_address = req.ip || req.connection?.remoteAddress;
    ud.client_user_agent = req.get('User-Agent') || '';

    // Extract fbp and fbc cookies
    const cookies = req.headers.cookie || '';
    const fbpMatch = cookies.match(/_fbp=([^;]+)/);
    const fbcMatch = cookies.match(/_fbc=([^;]+)/);
    if (fbpMatch) ud.fbp = fbpMatch[1];
    if (fbcMatch) ud.fbc = fbcMatch[1];
  }

  const eventData = {
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000),
    action_source: 'website',
    user_data: ud
  };

  // Event deduplication
  if (eventId) eventData.event_id = eventId;

  // Event source URL
  if (req) {
    eventData.event_source_url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  }

  // Custom data
  if (Object.keys(customData).length > 0) {
    eventData.custom_data = customData;
  }

  const payload = JSON.stringify({
    data: [eventData],
    ...(settings.meta_capi_test_code ? { test_event_code: settings.meta_capi_test_code } : {})
  });

  const options = {
    hostname: GRAPH_URL,
    path: `/${API_VERSION}/${pixelId}/events?access_token=${accessToken}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  const request = https.request(options, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      if (res.statusCode !== 200) {
        console.error('[Meta CAPI] Error:', res.statusCode, body);
      }
    });
  });

  request.on('error', (err) => {
    console.error('[Meta CAPI] Request error:', err.message);
  });

  request.write(payload);
  request.end();
}

/**
 * Track Purchase event (server-side)
 */
function trackPurchase(req, order, items) {
  const nameParts = (order.guest_name || '').split(' ');
  sendEvent('Purchase', {
    req: req || null,
    eventId: `purchase_${order.id}`,
    userData: {
      email: order.guest_email,
      phone: order.guest_phone,
      firstName: nameParts[0],
      lastName: nameParts.slice(1).join(' '),
      city: order.city,
      zipCode: order.zip_code
    },
    customData: {
      currency: 'TRY',
      value: order.total,
      content_type: 'product',
      contents: items.map(i => ({
        id: String(i.product_id),
        quantity: i.quantity,
        item_price: i.price
      })),
      num_items: items.reduce((s, i) => s + i.quantity, 0),
      order_id: String(order.id)
    }
  });
}

/**
 * Siparis onaylandiginda (admin veya telegram) Purchase event tetikle
 */
function triggerPurchaseForOrder(orderId) {
  try {
    const { db } = require('./database');
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) return;
    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
    trackPurchase(null, order, items);
    console.log(`[CAPI] Purchase event tetiklendi: #${orderId}`);
  } catch (e) {
    console.error('[CAPI] Purchase tetikleme hatasi:', e.message);
  }
}

/**
 * Track InitiateCheckout event (server-side)
 */
function trackInitiateCheckout(req, cart) {
  sendEvent('InitiateCheckout', {
    req,
    eventId: `checkout_${req.sessionID}_${Date.now()}`,
    customData: {
      currency: 'TRY',
      value: cart.reduce((s, i) => s + i.price * i.quantity, 0),
      content_type: 'product',
      contents: cart.map(i => ({
        id: String(i.productId),
        quantity: i.quantity,
        item_price: i.price
      })),
      num_items: cart.reduce((s, i) => s + i.quantity, 0)
    }
  });
}

/**
 * Track AddToCart event (server-side)
 */
function trackAddToCart(req, product) {
  const price = product.sale_price || product.price;
  sendEvent('AddToCart', {
    req,
    eventId: `atc_${product.id}_${Date.now()}`,
    customData: {
      currency: 'TRY',
      value: price,
      content_type: 'product',
      content_ids: [String(product.id)],
      content_name: product.name
    }
  });
}

/**
 * Track ViewContent event (server-side)
 */
function trackViewContent(req, product) {
  const price = product.sale_price || product.price;
  sendEvent('ViewContent', {
    req,
    eventId: `vc_${product.id}_${req.sessionID}`,
    customData: {
      currency: 'TRY',
      value: price,
      content_type: 'product',
      content_ids: [String(product.id)],
      content_name: product.name
    }
  });
}

module.exports = {
  sendEvent,
  trackPurchase,
  triggerPurchaseForOrder,
  trackInitiateCheckout,
  trackAddToCart,
  trackViewContent
};
