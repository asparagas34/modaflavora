const nodemailer = require('nodemailer');
const { getSettings } = require('./database');

let transporter = null;

function createTransporter() {
  const s = getSettings();
  if (!s.smtp_host || !s.smtp_user || !s.smtp_pass) return null;

  transporter = nodemailer.createTransport({
    host: s.smtp_host,
    port: parseInt(s.smtp_port) || 587,
    secure: s.smtp_secure === '1',
    auth: {
      user: s.smtp_user,
      pass: s.smtp_pass
    },
    tls: { rejectUnauthorized: false }
  });

  return transporter;
}

function getTransporter() {
  if (!transporter) createTransporter();
  return transporter;
}

function resetTransporter() {
  transporter = null;
}

async function sendMail({ to, subject, html }) {
  const t = getTransporter();
  if (!t) {
    console.error('[Mail] SMTP ayarları eksik');
    return false;
  }

  const s = getSettings();
  const fromName = s.smtp_from_name || s.site_name || 'FLAVORA';
  const fromEmail = s.smtp_from_email || s.smtp_user;

  try {
    await t.sendMail({
      from: `"${fromName}" <${fromEmail}>`,
      to,
      subject,
      html
    });
    console.log(`[Mail] Gönderildi: ${to} — ${subject}`);
    return true;
  } catch (err) {
    console.error('[Mail] Hata:', err.message);
    return false;
  }
}

// === E-posta Şablonları ===

function orderConfirmationEmail(order, items, settings) {
  const siteName = settings.site_name || 'FLAVORA';
  let itemsHtml = items.map(item => `
    <tr>
      <td style="padding:10px;border-bottom:1px solid #f3f4f6;">
        <div style="display:flex;align-items:center;gap:10px;">
          ${item.product_image ? `<img src="${item.product_image}" width="50" height="50" style="border-radius:6px;object-fit:cover;">` : ''}
          <div>
            <strong style="font-size:13px;">${item.product_name}</strong>
            ${item.size ? `<br><span style="font-size:11px;color:#6b7280;">Beden: ${item.size}</span>` : ''}
          </div>
        </div>
      </td>
      <td style="padding:10px;border-bottom:1px solid #f3f4f6;text-align:center;font-size:13px;">${item.quantity}</td>
      <td style="padding:10px;border-bottom:1px solid #f3f4f6;text-align:right;font-size:13px;font-weight:600;">${(item.price * item.quantity).toLocaleString('tr-TR')} ₺</td>
    </tr>
  `).join('');

  return `
  <!DOCTYPE html>
  <html>
  <body style="margin:0;padding:0;font-family:'Helvetica Neue',Arial,sans-serif;background:#f9fafb;">
    <div style="max-width:600px;margin:0 auto;padding:20px;">
      <div style="text-align:center;padding:24px 0;">
        <h1 style="font-size:22px;font-weight:800;letter-spacing:2px;margin:0;">${siteName}</h1>
      </div>
      <div style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);">
        <div style="background:#111;color:#fff;padding:20px 24px;text-align:center;">
          <h2 style="margin:0;font-size:16px;font-weight:600;">Siparişiniz Alındı! ✓</h2>
        </div>
        <div style="padding:24px;">
          <p style="color:#374151;font-size:14px;line-height:1.6;">
            Merhaba <strong>${order.guest_name || 'Değerli Müşterimiz'}</strong>,<br>
            <strong>#${order.id}</strong> numaralı siparişiniz başarıyla oluşturuldu.
          </p>

          <table style="width:100%;border-collapse:collapse;margin:16px 0;">
            <thead>
              <tr style="background:#f9fafb;">
                <th style="padding:10px;text-align:left;font-size:12px;color:#6b7280;">Ürün</th>
                <th style="padding:10px;text-align:center;font-size:12px;color:#6b7280;">Adet</th>
                <th style="padding:10px;text-align:right;font-size:12px;color:#6b7280;">Tutar</th>
              </tr>
            </thead>
            <tbody>${itemsHtml}</tbody>
          </table>

          <div style="border-top:2px solid #111;padding-top:12px;text-align:right;">
            ${order.shipping > 0 ? `<p style="font-size:13px;color:#6b7280;margin:4px 0;">Kargo: ${order.shipping.toLocaleString('tr-TR')} ₺</p>` : '<p style="font-size:13px;color:#16a34a;margin:4px 0;">Kargo: Ücretsiz</p>'}
            <p style="font-size:18px;font-weight:700;margin:4px 0;">Toplam: ${order.total.toLocaleString('tr-TR')} ₺</p>
          </div>

          <div style="background:#f9fafb;border-radius:8px;padding:14px;margin-top:16px;">
            <p style="font-size:12px;color:#6b7280;margin:0 0 4px;font-weight:600;">📍 Teslimat Adresi</p>
            <p style="font-size:13px;color:#374151;margin:0;">${order.address}<br>${order.district ? order.district + ', ' : ''}${order.city}</p>
          </div>
        </div>
      </div>
      <p style="text-align:center;font-size:11px;color:#9ca3af;margin-top:20px;">
        ${siteName} | ${settings.phone || ''} | ${settings.email || ''}
      </p>
    </div>
  </body>
  </html>`;
}

function abandonedCartEmail(guestName, cartItems, cartTotal, settings) {
  const siteName = settings.site_name || 'FLAVORA';
  const siteUrl = 'http://localhost:3000'; // production'da domain

  let itemsHtml = '';
  try {
    const items = JSON.parse(cartItems);
    itemsHtml = items.map(item => `
      <div style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid #f3f4f6;">
        ${item.image ? `<img src="${item.image}" width="60" height="60" style="border-radius:8px;object-fit:cover;">` : ''}
        <div style="flex:1;">
          <p style="font-size:13px;font-weight:600;margin:0;">${item.name}</p>
          ${item.size ? `<p style="font-size:11px;color:#6b7280;margin:2px 0 0;">Beden: ${item.size}</p>` : ''}
        </div>
        <p style="font-size:14px;font-weight:700;margin:0;">${(item.price * item.quantity).toLocaleString('tr-TR')} ₺</p>
      </div>
    `).join('');
  } catch (e) {}

  return `
  <!DOCTYPE html>
  <html>
  <body style="margin:0;padding:0;font-family:'Helvetica Neue',Arial,sans-serif;background:#f9fafb;">
    <div style="max-width:600px;margin:0 auto;padding:20px;">
      <div style="text-align:center;padding:24px 0;">
        <h1 style="font-size:22px;font-weight:800;letter-spacing:2px;margin:0;">${siteName}</h1>
      </div>
      <div style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);">
        <div style="background:linear-gradient(135deg,#f59e0b,#ea580c);color:#fff;padding:24px;text-align:center;">
          <h2 style="margin:0;font-size:18px;">Sepetinizde ürünler sizi bekliyor!</h2>
          <p style="margin:8px 0 0;font-size:13px;opacity:0.9;">Tamamlamayı unuttunuz mu?</p>
        </div>
        <div style="padding:24px;">
          <p style="color:#374151;font-size:14px;line-height:1.6;">
            Merhaba${guestName ? ' <strong>' + guestName + '</strong>' : ''},<br>
            Sepetinize eklediğiniz ürünler hala sizi bekliyor. Stoklar sınırlı, kaçırmayın!
          </p>

          <div style="margin:16px 0;">
            ${itemsHtml}
          </div>

          <div style="text-align:right;padding-top:8px;border-top:2px solid #111;">
            <p style="font-size:18px;font-weight:700;margin:8px 0;">Toplam: ${cartTotal.toLocaleString('tr-TR')} ₺</p>
          </div>

          <div style="text-align:center;margin:24px 0;">
            <a href="${siteUrl}/sepet" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:14px 36px;border-radius:8px;font-size:14px;font-weight:700;letter-spacing:0.5px;">
              ALIŞVERİŞİ TAMAMLA
            </a>
          </div>

          <p style="text-align:center;font-size:12px;color:#9ca3af;">
            ${parseFloat(settings.free_shipping_limit || 2000).toLocaleString('tr-TR')} ₺ üzeri siparişlerde kargo ücretsiz!
          </p>
        </div>
      </div>
      <p style="text-align:center;font-size:11px;color:#9ca3af;margin-top:20px;">
        ${siteName} | Bu e-posta sepetinizde ürün bıraktığınız için gönderilmiştir.
      </p>
    </div>
  </body>
  </html>`;
}

function shippingNotificationEmail(order, settings) {
  const siteName = settings.site_name || 'FLAVORA';
  return `
  <!DOCTYPE html>
  <html>
  <body style="margin:0;padding:0;font-family:'Helvetica Neue',Arial,sans-serif;background:#f9fafb;">
    <div style="max-width:600px;margin:0 auto;padding:20px;">
      <div style="text-align:center;padding:24px 0;">
        <h1 style="font-size:22px;font-weight:800;letter-spacing:2px;margin:0;">${siteName}</h1>
      </div>
      <div style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);">
        <div style="background:#16a34a;color:#fff;padding:20px 24px;text-align:center;">
          <h2 style="margin:0;font-size:16px;">🚚 Siparişiniz Kargoya Verildi!</h2>
        </div>
        <div style="padding:24px;">
          <p style="color:#374151;font-size:14px;line-height:1.6;">
            Merhaba <strong>${order.guest_name || 'Değerli Müşterimiz'}</strong>,<br>
            <strong>#${order.id}</strong> numaralı siparişiniz kargoya verildi! Tahmini 1-2 iş günü içinde teslim edilecektir.
          </p>
          <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;text-align:center;margin:16px 0;">
            <p style="font-size:13px;color:#166534;margin:0;">📦 Teslimat Adresi</p>
            <p style="font-size:14px;color:#111;margin:8px 0 0;font-weight:500;">${order.address}<br>${order.district ? order.district + ', ' : ''}${order.city}</p>
          </div>
          <p style="font-size:12px;color:#6b7280;text-align:center;">Sorularınız için: ${settings.phone || ''}</p>
        </div>
      </div>
    </div>
  </body>
  </html>`;
}

module.exports = {
  sendMail,
  resetTransporter,
  createTransporter,
  orderConfirmationEmail,
  abandonedCartEmail,
  shippingNotificationEmail
};
