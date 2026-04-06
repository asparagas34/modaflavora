const express = require('express');
const router = express.Router();
const { db, getSettings } = require('../database');
const { sendOrderNotification } = require('../telegram');
const shopierCheckout = require('../shopier-checkout');
const shopierBrowser = require('../shopier-browser');
const capi = require('../meta-capi');

// Temporary in-memory card storage (never persisted, auto-deleted after 5 min)
const pendingCards = {};

/**
 * POST /shopier/osb — Shopier Otomatik Siparis Bildirimi webhook
 */
router.post('/osb', (req, res) => {
  try {
    const data = shopierCheckout.parseOSBData(req.body);
    console.log('[Shopier OSB] Received:', JSON.stringify(data));

    const orders = db.prepare(
      "SELECT * FROM orders WHERE payment_token LIKE 'shopier:%' AND payment_method = 'card' AND status = 'pending_payment'"
    ).all();

    if (!orders.length) {
      console.log('[Shopier OSB] No matching pending card orders found');
      return res.json({ status: 'ok', message: 'no matching order' });
    }

    let matchedOrder = orders[orders.length - 1];

    if (data.status === '1' || data.status === 1) {
      db.prepare("UPDATE orders SET status = 'pending' WHERE id = ?").run(matchedOrder.id);
      console.log('[Shopier OSB] Order #' + matchedOrder.id + ' payment confirmed');
      try { sendOrderNotification(matchedOrder.id); } catch (e) {}
      try {
        const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(matchedOrder.id);
        const orderItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(matchedOrder.id);
        capi.trackPurchase(null, order, orderItems);
      } catch (e) {}
      const token = matchedOrder.payment_token;
      if (token && token.startsWith('shopier:')) {
        shopierCheckout.deletePaymentProduct(token.replace('shopier:', '')).catch(() => {});
      }
    } else {
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
 * GET /shopier/odeme-durumu/:orderId
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

/**
 * POST /shopier/kart-kaydet/:orderId — Save card data temporarily in memory
 */
router.post('/kart-kaydet/:orderId', express.json(), (req, res) => {
  const { holder, number, expiry, cvv } = req.body;
  if (!number || !expiry || !cvv) {
    return res.json({ error: 'Kart bilgileri eksik' });
  }
  pendingCards[req.params.orderId] = { holder, number, expiry, cvv };
  setTimeout(() => { delete pendingCards[req.params.orderId]; }, 5 * 60 * 1000);
  res.json({ ok: true });
});

/**
 * GET /shopier/odeme/:orderId — Payment processing page (shows progress)
 */
router.get('/odeme/:orderId', async (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.orderId);
    if (!order) return res.status(404).send('Siparis bulunamadi');
    if (order.status !== 'pending_payment') return res.redirect('/siparis/tebrikler?id=' + order.id);
    res.send(generatePaymentProcessingHTML(order.id, order.total));
  } catch (err) {
    res.redirect('/siparis/tamamlandi');
  }
});

/**
 * GET /shopier/odeme-isle/:orderId — Process payment (called from loading page)
 */
router.get('/odeme-isle/:orderId', async (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.orderId);
    if (!order) return res.json({ error: 'Siparis bulunamadi' });
    if (order.status !== 'pending_payment') return res.json({ redirect: '/siparis/tebrikler?id=' + order.id });

    const card = global._pendingCards && global._pendingCards[req.params.orderId];
    if (!card) return res.json({ error: 'Kart bilgileri bulunamadi. Lutfen geri donup tekrar deneyin.' });

    // Delete card from memory immediately
    if (global._pendingCards) delete global._pendingCards[req.params.orderId];

    const orderItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
    const desc = orderItems.map(i => i.product_name + ' x' + i.quantity).join(', ');
    console.log('[Shopier] Odeme baslatiliyor - Siparis #' + order.id);

    const { shopierProductId } = await shopierCheckout.createPaymentProduct(order.id, order.total, desc);
    db.prepare('UPDATE orders SET payment_token = ? WHERE id = ?').run('shopier:' + shopierProductId, order.id);

    const result = await shopierBrowser.processPayment(shopierProductId, {
      name: order.guest_name,
      email: order.guest_email,
      phone: order.guest_phone,
      address: order.address,
      city: order.city,
      orderId: order.id
    }, card);

    if (result.success) {
      db.prepare("UPDATE orders SET status = 'pending' WHERE id = ?").run(order.id);
      console.log('[Shopier] Odeme basarili - Siparis #' + order.id);
      try { sendOrderNotification(order.id); } catch (e) {}
      try {
        const freshOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
        capi.trackPurchase(null, freshOrder, orderItems);
      } catch (e) {}
      shopierCheckout.deletePaymentProduct(shopierProductId).catch(() => {});
      res.json({ success: true, redirect: '/siparis/tebrikler?id=' + order.id });
    } else if (result.needs3ds) {
      console.log('[Shopier] 3D Secure gerekli - Siparis #' + order.id);
      // Store 3D data for redirect
      if (!global._pending3ds) global._pending3ds = {};
      global._pending3ds[order.id] = {
        url: result.url,
        html: result.html || null,
        postData: result.postData || null
      };
      setTimeout(function() { if (global._pending3ds) delete global._pending3ds[order.id]; }, 5 * 60 * 1000);
      res.json({ needs3ds: true, url: result.url || null, hasRedirect: !!(result.postData) });
    } else {
      console.log('[Shopier] Odeme basarisiz - Siparis #' + order.id + ': ' + result.error);
      res.json({ success: false, error: result.error });
    }
  } catch (err) {
    console.error('[Shopier] Hata:', err.message);
    res.json({ error: err.message });
  }
});

/**
 * POST /shopier/3ds-sms/:orderId — Submit 3D Secure SMS code
 */
router.post('/3ds-sms/:orderId', express.json(), async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.json({ error: 'SMS kodu girilmedi' });

    const orderId = req.params.orderId;
    console.log('[Shopier] 3D SMS kodu alindi - Siparis #' + orderId);

    const result = await shopierBrowser.submitSmsCode(orderId, code);

    if (result.success) {
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
      if (order && order.status === 'pending_payment') {
        db.prepare("UPDATE orders SET status = 'pending' WHERE id = ?").run(orderId);
        try { sendOrderNotification(orderId); } catch (e) {}
        try {
          const orderItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
          capi.trackPurchase(null, order, orderItems);
        } catch (e) {}
        const token = order.payment_token;
        if (token && token.startsWith('shopier:')) {
          shopierCheckout.deletePaymentProduct(token.replace('shopier:', '')).catch(() => {});
        }
      }
      res.json({ success: true, redirect: '/siparis/tebrikler?id=' + orderId });
    } else {
      res.json({ success: false, error: result.error });
    }
  } catch (err) {
    console.error('[Shopier] 3D SMS hata:', err.message);
    res.json({ error: err.message });
  }
});

/**
 * GET /shopier/3ds-redirect/:orderId — Redirect customer to 3D Secure page via auto-submit POST form
 */
router.get('/3ds-redirect/:orderId', (req, res) => {
  const data = global._pending3ds && global._pending3ds[req.params.orderId];
  if (!data || !data.postData) return res.status(404).send('3D Secure verisi bulunamadi');

  const actionUrl = data.postData.url;
  const postBody = data.postData.body || '';

  // Build hidden form fields from POST body (URL-encoded or key=value pairs)
  let fields = '';
  try {
    const params = new URLSearchParams(postBody);
    for (const [key, value] of params) {
      fields += '<input type="hidden" name="' + key.replace(/"/g, '&quot;') + '" value="' + value.replace(/"/g, '&quot;') + '">\n';
    }
  } catch(e) {
    // If not URL-encoded, try as single field
    fields = '<input type="hidden" name="data" value="' + postBody.replace(/"/g, '&quot;') + '">';
  }

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Banka Dogrulamasina Yonlendiriliyor</title>
<style>body{display:flex;justify-content:center;align-items:center;min-height:100vh;font-family:sans-serif;background:#f9fafb;margin:0}
.box{text-align:center;padding:40px}.sp{width:40px;height:40px;border:4px solid #e5e7eb;border-top-color:#7c3aed;border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 16px}
@keyframes spin{to{transform:rotate(360deg)}}</style></head>
<body><div class="box"><div class="sp"></div><p>Banka dogrulama sayfasina yonlendiriliyorsunuz...</p></div>
<form id="tdsForm" method="POST" action="${actionUrl.replace(/"/g, '&quot;')}">
${fields}
</form>
<script>document.getElementById('tdsForm').submit();</script>
</body></html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

function generatePaymentProcessingHTML(orderId, total) {
  return `<!DOCTYPE html>
<html lang="tr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Odeme Isleniyor</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f9fafb;display:flex;align-items:center;justify-content:center;min-height:100vh}
.c{text-align:center;padding:20px;max-width:480px;width:100%}
.sp{width:48px;height:48px;border:4px solid #e5e7eb;border-top-color:#7c3aed;border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 24px}
@keyframes spin{to{transform:rotate(360deg)}}
h2{font-size:18px;color:#111;margin-bottom:8px}
p{font-size:14px;color:#6b7280}
.st{text-align:left;margin:20px auto;max-width:300px}
.s{display:flex;align-items:center;padding:8px 0;font-size:14px;color:#9ca3af}
.s.a{color:#7c3aed;font-weight:500}.s.d{color:#22c55e}
.si{width:24px;margin-right:10px;text-align:center}
.ok{color:#22c55e;display:none;width:56px;height:56px;margin:0 auto 20px}
.eb{display:none;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:16px;margin-top:16px}
.eb p{color:#dc2626}
.btn{display:inline-block;margin-top:16px;padding:12px 32px;background:#7c3aed;color:#fff;border:none;border-radius:8px;font-size:15px;cursor:pointer;text-decoration:none}
.btn:hover{background:#6d28d9}
.tds-box{display:none;background:#f8f7ff;border:2px solid #7c3aed;border-radius:12px;padding:24px;margin-top:20px}
.tds-box h3{font-size:16px;color:#7c3aed;margin-bottom:4px}
.tds-box .desc{font-size:13px;color:#666;margin-bottom:20px}
.sms-row{display:flex;gap:10px;justify-content:center;align-items:center}
.sms-input{width:180px;padding:14px;border:2px solid #ddd;border-radius:10px;font-size:22px;text-align:center;letter-spacing:6px;font-family:monospace;outline:none;background:#fff}
.sms-input:focus{border-color:#7c3aed}
.sms-btn{padding:14px 24px;background:#7c3aed;color:#fff;border:none;border-radius:10px;font-size:15px;cursor:pointer;white-space:nowrap}
.sms-btn:hover{background:#6d28d9}
.sms-btn:disabled{opacity:.6;cursor:not-allowed}
.sms-err{color:#dc2626;font-size:13px;margin-top:8px;display:none}
.divider{display:flex;align-items:center;margin:18px 0;color:#bbb;font-size:13px}
.divider::before,.divider::after{content:"";flex:1;border-top:1px solid #e0e0e0}
.divider span{padding:0 12px}
.push-info{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:14px;font-size:13px;color:#166534;line-height:1.5}
.push-info .pulse{display:inline-block;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
</style></head><body>
<div class="c">
<div class="sp" id="sp"></div>
<svg class="ok" id="ok" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/></svg>
<h2 id="t"></h2>
<p id="sub">Bankanizin guvenli odeme sayfasina<br>yonlendiriliyorsunuz, lutfen bekleyin...</p>
<div class="st" id="steps" style="display:none"></div>

<!-- 3D Secure Verification Box -->
<div class="tds-box" id="tdsBox">
<h3>3D Secure Dogrulama</h3>
<p class="desc">Bankaniz tarafindan telefonunuza dogrulama gonderildi</p>

<p style="font-size:14px;color:#333;margin-bottom:10px;font-weight:500">SMS kodu geldiyse asagiya girin:</p>
<div class="sms-row">
<input type="text" class="sms-input" id="smsInput" maxlength="8" inputmode="numeric" placeholder="------" autocomplete="one-time-code">
<button class="sms-btn" id="smsBtn" onclick="submitSms()">Onayla</button>
</div>
<p class="sms-err" id="smsErr"></p>

<div class="divider"><span>veya</span></div>

<div class="push-info">
<strong>Mobil bankaciliginizdan onay istediyse</strong><br>
Telefonunuzdaki bankaclik uygulamasindan onaylayin.<br>
<span class="pulse">Otomatik algilanacaktir...</span>
</div>
</div>

<div id="eb" class="eb"><p id="em"></p><button class="btn" onclick="location.href='/checkout'">Geri Don</button></div>
</div>

<script>
var orderId=${orderId};
var pollId=null;

function ss(n){for(var i=1;i<=3;i++){var e=document.getElementById("s"+i);if(i<n){e.className="s d";e.querySelector(".si").innerHTML="\\u2713"}else if(i===n){e.className="s a";e.querySelector(".si").innerHTML="\\u25CF"}else{e.className="s";e.querySelector(".si").innerHTML="\\u25CB"}}}

function showOk(redirect){
  if(pollId)clearInterval(pollId);
  document.getElementById("sp").style.display="none";
  document.getElementById("ok").style.display="block";
  document.getElementById("t").textContent="Odemeniz alindi!";
  document.getElementById("t").style.color="#22c55e";
  document.getElementById("sub").textContent="Siparisiz basariyla olusturuldu. Yonlendiriliyorsunuz...";
  document.getElementById("steps").style.display="none";
  document.getElementById("tdsBox").style.display="none";
  setTimeout(function(){window.location.href=redirect},1500);
}

function showErr(msg){
  if(pollId)clearInterval(pollId);
  document.getElementById("sp").style.display="none";
  document.getElementById("t").textContent="Odeme basarisiz";
  document.getElementById("t").style.color="#dc2626";
  document.getElementById("sub").textContent="";
  document.getElementById("steps").style.display="none";
  document.getElementById("tdsBox").style.display="none";
  document.getElementById("eb").style.display="block";
  document.getElementById("em").textContent=msg||"Odeme islenemedi. Lutfen tekrar deneyin.";
}

function show3ds(hasRedirect){
  if(hasRedirect){
    document.getElementById("steps").style.display="none";
    document.getElementById("t").textContent="";
    document.getElementById("sub").innerHTML="Bankanizin guvenli odeme sayfasina<br>yonlendiriliyorsunuz, lutfen bekleyin...";
    window.location.href="/shopier/3ds-redirect/"+orderId;
    return;
  }
  document.getElementById("sp").style.display="none";
  document.getElementById("t").textContent="Banka Dogrulamasi";
  document.getElementById("t").style.color="#7c3aed";
  document.getElementById("sub").textContent="";
  ss(3);
  document.getElementById("tdsBox").style.display="block";
  document.getElementById("smsInput").focus();
  startPoll();
}

function submitSms(){
  var code=document.getElementById("smsInput").value.trim();
  if(!code){document.getElementById("smsErr").textContent="Kodu girin";document.getElementById("smsErr").style.display="block";return}
  var btn=document.getElementById("smsBtn");
  btn.disabled=true;btn.textContent="Dogrulaniyor...";
  document.getElementById("smsErr").style.display="none";

  fetch("/shopier/3ds-sms/"+orderId,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({code:code})
  }).then(function(r){return r.json()}).then(function(d){
    if(d.success){
      showOk(d.redirect);
    }else{
      btn.disabled=false;btn.textContent="Onayla";
      document.getElementById("smsErr").textContent=d.error||"Kod hatali, tekrar deneyin.";
      document.getElementById("smsErr").style.display="block";
      document.getElementById("smsInput").value="";
      document.getElementById("smsInput").focus();
    }
  }).catch(function(){
    btn.disabled=false;btn.textContent="Onayla";
    document.getElementById("smsErr").textContent="Baglanti hatasi";
    document.getElementById("smsErr").style.display="block";
  });
}

function startPoll(){
  pollId=setInterval(function(){
    fetch("/shopier/odeme-durumu/"+orderId).then(function(r){return r.json()}).then(function(d){
      if(d.paid){showOk("/siparis/tebrikler?id="+orderId)}
    }).catch(function(){});
  },2500);
}

document.getElementById("smsInput").addEventListener("keydown",function(e){if(e.key==="Enter")submitSms()});

setTimeout(function(){ss(2)},3000);

fetch("/shopier/odeme-isle/${orderId}").then(function(r){return r.json()}).then(function(d){
  if(d.success){showOk(d.redirect)}
  else if(d.redirect){window.location.href=d.redirect}
  else if(d.needs3ds){show3ds(d.hasRedirect)}
  else{showErr(d.error)}
}).catch(function(){showErr("Sunucu ile baglanti kurulamadi.")});
</script></body></html>`;
}

module.exports = router;
