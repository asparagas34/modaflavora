/**
 * Shopier Checkout Integration
 *
 * Flow:
 * 1. Customer selects card payment on our checkout
 * 2. We create a temporary "payment product" on Shopier with the order total
 * 3. Customer's browser auto-submits to Shopier checkout with this product
 * 4. Customer enters card details on Shopier's secure payment page
 * 5. OSB webhook notifies us when payment is complete
 */

const axios = require('axios');
const crypto = require('crypto');

// Shopier API credentials - reads from DB settings or env var
const SHOPIER_STORE = 'modaflavora';
const SHOPIER_API_BASE = 'https://api.shopier.com/api/v1';

function getShopierPAT() {
  // Try DB settings first, then env var
  try {
    const { getSettings } = require('./database');
    const settings = getSettings();
    if (settings.shopier_pat) return settings.shopier_pat;
  } catch (e) {}
  return process.env.SHOPIER_PAT || '';
}

// OSB credentials (for webhook verification)
const OSB_USERNAME = process.env.SHOPIER_OSB_USERNAME || '2b3d599ca6965557ca2833b17cc3ae0a';
const OSB_PASSWORD = process.env.SHOPIER_OSB_PASSWORD || '8da73e363a27193b2600150ed48e166d';

/**
 * Create a temporary product on Shopier for this order's payment
 * @param {number} orderId - Our order ID
 * @param {number} totalAmount - Order total in TL (e.g., 800.24)
 * @param {string} description - Order description
 * @returns {Promise<{shopierProductId: string, shopierProductUrl: string}>}
 */
async function createPaymentProduct(orderId, totalAmount, description) {
  const SHOPIER_PAT = getShopierPAT();
  if (!SHOPIER_PAT) throw new Error('Shopier API token (PAT) ayarlanmamış. Admin > Ayarlar > Kredi Kartı bölümünden girin.');

  // Price in kuruş (cents)
  const priceInKurus = Math.round(totalAmount * 100);

  const productData = {
    title: `Sipariş #${orderId}`,
    description: description || `ModaFlavora sipariş ödemesi #${orderId}`,
    price: priceInKurus,
    stock: 1,
    is_active: true,
    categories: []
  };

  try {
    const resp = await axios.post(`${SHOPIER_API_BASE}/products`, productData, {
      headers: {
        'Authorization': `Bearer ${SHOPIER_PAT}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 15000
    });

    const product = resp.data.data || resp.data;
    const productId = product.id || product.product_id;

    return {
      shopierProductId: String(productId),
      shopierProductUrl: `https://www.shopier.com/${productId}`
    };
  } catch (err) {
    console.error('[Shopier] Create payment product error:', err.response?.data || err.message);
    throw new Error('Shopier ödeme ürünü oluşturulamadı: ' + (err.response?.data?.message || err.message));
  }
}

/**
 * Delete a temporary payment product from Shopier
 * @param {string} shopierProductId
 */
async function deletePaymentProduct(shopierProductId) {
  const SHOPIER_PAT = getShopierPAT();
  if (!SHOPIER_PAT || !shopierProductId) return;

  try {
    await axios.delete(`${SHOPIER_API_BASE}/products/${shopierProductId}`, {
      headers: {
        'Authorization': `Bearer ${SHOPIER_PAT}`,
        'Accept': 'application/json'
      },
      timeout: 10000
    });
    console.log('[Shopier] Deleted payment product:', shopierProductId);
  } catch (err) {
    console.error('[Shopier] Delete payment product error:', err.response?.data || err.message);
  }
}

/**
 * Generate HTML page that auto-submits to Shopier checkout
 * @param {string} shopierProductId - The Shopier product ID
 * @param {object} orderInfo - Order info for display
 * @returns {string} HTML string
 */
function generateCheckoutRedirectHTML(shopierProductId, orderInfo) {
  return `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ödeme Sayfasına Yönlendiriliyor...</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:#f9fafb; display:flex; align-items:center; justify-content:center; min-height:100vh; }
    .container { text-align:center; padding:40px; }
    .spinner { width:48px; height:48px; border:4px solid #e5e7eb; border-top-color:#111; border-radius:50%; animation:spin 0.8s linear infinite; margin:0 auto 24px; }
    @keyframes spin { to { transform:rotate(360deg); } }
    h2 { font-size:18px; color:#111; margin-bottom:8px; }
    p { font-size:14px; color:#6b7280; margin-bottom:4px; }
    .order-info { font-size:13px; color:#9ca3af; margin-top:16px; }
    .fallback { margin-top:24px; }
    .fallback a { display:inline-block; background:#111; color:#fff; text-decoration:none; padding:12px 24px; border-radius:8px; font-size:14px; font-weight:600; }
  </style>
</head>
<body>
  <div class="container">
    <div class="spinner"></div>
    <h2>Güvenli ödeme sayfasına yönlendiriliyorsunuz...</h2>
    <p>Lütfen bekleyin, Shopier ödeme sayfası açılıyor.</p>
    <p class="order-info">Sipariş #${orderInfo.orderId} — ${orderInfo.total} ₺</p>
    <div class="fallback" id="fallback" style="display:none;">
      <p style="margin-bottom:12px;">Yönlendirme çalışmadıysa butona tıklayın:</p>
      <a href="https://www.shopier.com/${shopierProductId}" id="fallbackLink">Ödeme Sayfasına Git</a>
    </div>
  </div>

  <form id="shopierForm" method="POST" action="https://www.shopier.com/s/shipping/${SHOPIER_STORE}">
    <input type="hidden" name="product_id" value="${shopierProductId}">
    <input type="hidden" name="quantity" value="1">
  </form>

  <script>
    // Auto-submit form after a brief delay
    setTimeout(function() {
      document.getElementById('shopierForm').submit();
    }, 800);

    // Show fallback link after 5 seconds
    setTimeout(function() {
      document.getElementById('fallback').style.display = 'block';
    }, 5000);
  </script>
</body>
</html>`;
}

/**
 * Verify OSB webhook signature from Shopier
 * @param {object} body - Webhook request body
 * @returns {boolean}
 */
function verifyOSBWebhook(body) {
  // Shopier OSB sends: res (status), platform_order_id, payment_id, installment_count, signature
  const { signature, ...data } = body;
  if (!signature) return false;

  // Generate expected signature
  const dataStr = Object.values(data).join('');
  const expectedSig = crypto
    .createHmac('sha256', OSB_PASSWORD)
    .update(dataStr)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expectedSig, 'hex')
    );
  } catch {
    return false;
  }
}

/**
 * Parse OSB webhook data
 * @param {object} body - Webhook body
 * @returns {object} Parsed order info
 */
function parseOSBData(body) {
  return {
    status: body.res,                    // 1 = success, 0 = fail
    platformOrderId: body.platform_order_id,
    paymentId: body.payment_id,
    installmentCount: body.installment_count || 1,
    signature: body.signature
  };
}

module.exports = {
  createPaymentProduct,
  deletePaymentProduct,
  generateCheckoutRedirectHTML,
  verifyOSBWebhook,
  parseOSBData,
  SHOPIER_STORE
};
