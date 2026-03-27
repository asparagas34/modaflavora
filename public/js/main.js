// ===== MOBILE MENU =====
const mobileMenuBtn = document.getElementById('mobileMenuBtn');
const mainNav = document.getElementById('mainNav');

if (mobileMenuBtn) {
  mobileMenuBtn.addEventListener('click', () => {
    mainNav.classList.toggle('active');
    mobileMenuBtn.classList.toggle('active');
  });
  document.addEventListener('click', (e) => {
    if (!mainNav.contains(e.target) && !mobileMenuBtn.contains(e.target)) {
      mainNav.classList.remove('active');
    }
  });
}

// ===== MOBILE DROPDOWN ACCORDION =====
if (window.innerWidth <= 768) {
  document.querySelectorAll('.nav-dropdown').forEach(dd => {
    const trigger = dd.querySelector('.dropdown-trigger');
    if (!trigger) return;
    const hasChildren = dd.querySelector('.dropdown-menu');
    if (!hasChildren) return;

    trigger.addEventListener('click', (e) => {
      if (dd.classList.contains('open')) {
        // Zaten açıksa linke git
        return;
      }
      e.preventDefault();
      // Diğerlerini kapat
      document.querySelectorAll('.nav-dropdown.open').forEach(other => {
        if (other !== dd) other.classList.remove('open');
      });
      dd.classList.add('open');
    });
  });
}

// ===== SEARCH =====
const searchToggle = document.getElementById('searchToggle');
const searchOverlay = document.getElementById('searchOverlay');
const searchClose = document.getElementById('searchClose');
const searchInput = document.getElementById('searchInput');
const searchResults = document.getElementById('searchResults');

if (searchToggle) {
  searchToggle.addEventListener('click', () => {
    searchOverlay.classList.toggle('active');
    if (searchOverlay.classList.contains('active')) searchInput.focus();
  });
}
if (searchClose) {
  searchClose.addEventListener('click', () => searchOverlay.classList.remove('active'));
}

let searchTimeout;
if (searchInput) {
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    const q = searchInput.value.trim();
    if (q.length < 2) { searchResults.innerHTML = ''; return; }
    searchTimeout = setTimeout(() => {
      fetch('/api/search?q=' + encodeURIComponent(q))
        .then(r => r.json())
        .then(products => {
          if (products.length === 0) {
            searchResults.innerHTML = '<p style="padding:15px;color:#999;">Sonuç bulunamadı</p>';
            return;
          }
          searchResults.innerHTML = products.map(p => `
            <a href="/urun/${p.slug}">
              ${p.image ? `<img src="${p.image}" alt="">` : ''}
              <div>
                <strong>${p.name}</strong>
                <span style="color:#999;font-size:13px;">${(p.sale_price || p.price).toLocaleString('tr-TR')} ₺</span>
              </div>
            </a>
          `).join('');
        });
    }, 300);
  });
}

// ===== HERO SLIDER =====
let currentSlide = 0;
const slides = document.querySelectorAll('.hero-slider .slide');
const dots = document.querySelectorAll('.hero-slider .dot');

function changeSlide(direction) {
  if (slides.length === 0) return;
  slides[currentSlide].classList.remove('active');
  if (dots[currentSlide]) dots[currentSlide].classList.remove('active');
  currentSlide = (currentSlide + direction + slides.length) % slides.length;
  slides[currentSlide].classList.add('active');
  if (dots[currentSlide]) dots[currentSlide].classList.add('active');
}
function goToSlide(index) {
  if (slides.length === 0) return;
  slides[currentSlide].classList.remove('active');
  if (dots[currentSlide]) dots[currentSlide].classList.remove('active');
  currentSlide = index;
  slides[currentSlide].classList.add('active');
  if (dots[currentSlide]) dots[currentSlide].classList.add('active');
}
if (slides.length > 1) setInterval(() => changeSlide(1), 4000);

// ===== CART DRAWER =====
const cartDrawer = document.getElementById('cartDrawer');
const cartDrawerOverlay = document.getElementById('cartDrawerOverlay');
const cartDrawerClose = document.getElementById('cartDrawerClose');
const FREE_SHIPPING_LIMIT = parseInt(document.body.dataset.freeShipping || '2000');
const SHIPPING_COST = parseFloat(document.body.dataset.shippingCost || '49.90');

function openCartDrawer() {
  if (!cartDrawer) return;
  cartDrawer.classList.add('open');
  cartDrawerOverlay.classList.add('active');
  document.body.style.overflow = 'hidden';
  loadCartDrawer();
}

function closeCartDrawer() {
  if (!cartDrawer) return;
  cartDrawer.classList.remove('open');
  cartDrawerOverlay.classList.remove('active');
  document.body.style.overflow = '';
}

if (cartDrawerClose) cartDrawerClose.addEventListener('click', closeCartDrawer);
if (cartDrawerOverlay) cartDrawerOverlay.addEventListener('click', closeCartDrawer);

// Escape tuşu
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCartDrawer(); });

// Sepet ikonuna tıklayınca çekmeceyi aç
const cartIcons = document.querySelectorAll('.cart-icon');
cartIcons.forEach(icon => {
  icon.addEventListener('click', (e) => {
    e.preventDefault();
    openCartDrawer();
  });
});

function loadCartDrawer() {
  fetch('/api/cart/data')
    .then(r => r.json())
    .then(data => renderCartDrawer(data))
    .catch(() => {});
}

function renderCartDrawer(data) {
  const itemsEl = document.getElementById('cartDrawerItems');
  const footerEl = document.getElementById('cartDrawerFooter');
  const emptyEl = document.getElementById('cartDrawerEmpty');
  const countEl = document.getElementById('drawerCount');
  const totalEl = document.getElementById('drawerTotal');
  const shippingEl = document.getElementById('drawerShipping');
  const shippingBar = document.getElementById('shippingBar');

  const items = data.items || [];
  const total = data.total || 0;
  const count = items.reduce((s, i) => s + i.quantity, 0);

  if (countEl) countEl.textContent = count;
  const badge = document.getElementById('cartBadge');
  if (badge) badge.textContent = count;

  if (items.length === 0) {
    if (emptyEl) emptyEl.style.display = 'flex';
    if (footerEl) footerEl.style.display = 'none';
    if (itemsEl) itemsEl.innerHTML = '';
    itemsEl.appendChild(emptyEl);
    return;
  }

  if (emptyEl) emptyEl.style.display = 'none';
  if (footerEl) footerEl.style.display = 'block';

  // Kargo ücreti
  const shipping = total >= FREE_SHIPPING_LIMIT ? 0 : SHIPPING_COST;
  const remaining = FREE_SHIPPING_LIMIT - total;
  const progress = Math.min(100, (total / FREE_SHIPPING_LIMIT) * 100);

  if (shippingEl) {
    shippingEl.textContent = shipping === 0 ? 'Ücretsiz 🎉' : shipping.toLocaleString('tr-TR') + ' ₺';
    shippingEl.style.color = shipping === 0 ? '#22c55e' : '';
  }
  if (totalEl) totalEl.textContent = total.toLocaleString('tr-TR') + ' ₺';

  if (shippingBar) {
    if (shipping === 0) {
      shippingBar.innerHTML = `<div class="shipping-success">🎉 Ücretsiz kargo kazandınız!</div>`;
    } else {
      shippingBar.innerHTML = `
        <div class="shipping-bar-text">Ücretsiz kargo için <strong>${remaining.toLocaleString('tr-TR')} ₺</strong> daha ekle</div>
        <div class="shipping-bar-track"><div class="shipping-bar-fill" style="width:${progress}%"></div></div>
      `;
    }
  }

  // Ürün listesi
  if (itemsEl) {
    itemsEl.innerHTML = items.map((item, index) => `
      <div class="drawer-item" data-index="${index}">
        <div class="drawer-item-img">
          ${item.image ? `<img src="${item.image}" alt="${item.name}">` : '<div class="no-img"></div>'}
        </div>
        <div class="drawer-item-info">
          <a href="/urun/${item.slug}" class="drawer-item-name">${item.name}</a>
          ${item.size ? `<span class="drawer-item-meta">Beden: ${item.size}</span>` : ''}
          <div class="drawer-item-actions">
            <div class="drawer-qty">
              <button class="qty-btn" onclick="changeDrawerQty(${index}, ${item.quantity - 1})">−</button>
              <span>${item.quantity}</span>
              <button class="qty-btn" onclick="changeDrawerQty(${index}, ${item.quantity + 1})">+</button>
            </div>
            <span class="drawer-item-price">${(item.price * item.quantity).toLocaleString('tr-TR')} ₺</span>
          </div>
        </div>
        <button class="drawer-item-remove" onclick="removeDrawerItem(${index})" aria-label="Kaldır">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    `).join('');
  }
}

function changeDrawerQty(index, newQty) {
  fetch('/api/cart/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ index, quantity: newQty })
  }).then(() => loadCartDrawer());
}

function removeDrawerItem(index) {
  fetch('/api/cart/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ index })
  }).then(() => loadCartDrawer());
}

// ===== ADD TO CART =====
function addToCart(productId, productName, size, color) {
  const selectedSize = size || document.querySelector('.size-btn.active')?.dataset.size || '';
  const selectedColor = color || document.querySelector('.color-btn.active')?.dataset.color || '';

  fetch('/api/cart/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productId, size: selectedSize, color: selectedColor, quantity: 1 })
  })
  .then(r => r.json())
  .then(data => {
    if (data.success) {
      const badge = document.getElementById('cartBadge');
      if (badge) badge.textContent = data.cartCount;

      // Meta Pixel AddToCart (deduplication ile)
      if (typeof fbq !== 'undefined' && data.product) {
        fbq('track', 'AddToCart', {
          content_ids: [String(data.product.id)],
          content_name: data.product.name,
          content_type: 'product',
          value: data.product.price,
          currency: 'TRY'
        }, data.atcEventId ? { eventID: data.atcEventId } : undefined);
      }

      // Sepet çekmecesini aç
      openCartDrawer();
    }
  });
}

// ===== TOAST =====
function showToast(message) {
  const toast = document.getElementById('cartToast');
  if (!toast) return;
  toast.querySelector('span').textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3000);
}

// ===== SIDEBAR FILTER (MOBILE) =====
const filterToggle = document.getElementById('filterToggle');
const sidebar = document.getElementById('sidebar');
const sidebarClose = document.getElementById('sidebarClose');

if (filterToggle && sidebar) filterToggle.addEventListener('click', () => sidebar.classList.add('active'));
if (sidebarClose && sidebar) sidebarClose.addEventListener('click', () => sidebar.classList.remove('active'));

// ===== HEADER SCROLL =====
let lastScroll = 0;
window.addEventListener('scroll', () => {
  const header = document.getElementById('header');
  if (!header) return;
  const currentScroll = window.pageYOffset;
  header.style.boxShadow = currentScroll > 100 ? '0 2px 10px rgba(0,0,0,0.08)' : 'none';
  lastScroll = currentScroll;
});
