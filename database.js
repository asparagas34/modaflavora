const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const db = new Database(path.join(__dirname, 'butik.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      parent_id INTEGER,
      image TEXT,
      sort_order INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (parent_id) REFERENCES categories(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      description TEXT,
      price REAL NOT NULL,
      sale_price REAL,
      category_id INTEGER,
      image TEXT,
      images TEXT DEFAULT '[]',
      sizes TEXT DEFAULT '[]',
      colors TEXT DEFAULT '[]',
      stock INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      is_featured INTEGER DEFAULT 0,
      is_new INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      phone TEXT,
      address TEXT,
      city TEXT,
      is_admin INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      guest_name TEXT,
      guest_email TEXT,
      guest_phone TEXT,
      address TEXT NOT NULL,
      city TEXT NOT NULL,
      district TEXT,
      zip_code TEXT,
      note TEXT,
      subtotal REAL NOT NULL,
      shipping REAL DEFAULT 0,
      discount REAL DEFAULT 0,
      total REAL NOT NULL,
      status TEXT DEFAULT 'pending',
      payment_method TEXT DEFAULT 'cod',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      product_id INTEGER,
      product_name TEXT NOT NULL,
      product_image TEXT,
      price REAL NOT NULL,
      quantity INTEGER NOT NULL,
      size TEXT,
      color TEXT,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS sliders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      subtitle TEXT,
      image TEXT NOT NULL,
      link TEXT,
      sort_order INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS abandoned_cart_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      guest_name TEXT,
      cart_data TEXT,
      cart_total REAL DEFAULT 0,
      email_sent INTEGER DEFAULT 0,
      sent_at DATETIME,
      recovered INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      author_name TEXT NOT NULL,
      author_city TEXT,
      rating INTEGER DEFAULT 5,
      title TEXT,
      comment TEXT NOT NULL,
      is_verified INTEGER DEFAULT 0,
      is_approved INTEGER DEFAULT 1,
      helpful_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS site_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      page TEXT,
      page_label TEXT,
      device TEXT DEFAULT 'desktop',
      referrer TEXT,
      cart_total REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_site_events_session ON site_events(session_id);
    CREATE INDEX IF NOT EXISTS idx_site_events_type ON site_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_site_events_date ON site_events(created_at);

    CREATE TABLE IF NOT EXISTS favorites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
      UNIQUE(user_id, product_id)
    );

    CREATE TABLE IF NOT EXISTS whatsapp_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      message_type TEXT NOT NULL,
      order_id INTEGER,
      template TEXT,
      status TEXT DEFAULT 'pending',
      error TEXT,
      sent_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_wa_logs_phone ON whatsapp_logs(phone);
    CREATE INDEX IF NOT EXISTS idx_wa_logs_type ON whatsapp_logs(message_type);
  `);

  // Default settings
  const defaultSettings = {
    site_name: 'FLAVORA',
    site_description: 'Şıklığı ve Zarafeti Buluşturan Modern Kadın Giyim',
    phone: '+90 555 123 4567',
    email: 'info@flavora.com',
    address: 'İstanbul, Türkiye',
    instagram: '#',
    facebook: '#',
    pinterest: '#',
    free_shipping_limit: '2000',
    shipping_cost: '49.90',
    announcement: 'Seçili Ürünlerde %30 İndirim Başladı!',
    cod_enabled: '0',
    bank_holder: '',
    bank_name: '',
    bank_branch: '',
    bank_iban: '',
    payment_eft_desc: 'Banka havalesi ile güvenli ödeme — sipariş onaylanır',
    payment_eft_note: 'Havale açıklamasına ad soyadınızı ve sipariş numaranızı yazmayı unutmayın. Ödeme onaylandıktan sonra siparişiniz kargoya verilir.',
    telegram_bot_token: '',
    telegram_chat_id: '',
    meta_capi_token: '',
    meta_capi_test_code: '',
    // E-posta ayarları
    smtp_host: '',
    smtp_port: '587',
    smtp_user: '',
    smtp_pass: '',
    smtp_from_name: '',
    smtp_from_email: '',
    smtp_secure: '0',
    // Otomasyon
    abandoned_cart_enabled: '0',
    abandoned_cart_delay: '30',
    abandoned_cart_subject: 'Sepetinizde ürünler sizi bekliyor!',
    order_confirmation_enabled: '0',
    shipping_notification_enabled: '0',
    reviews_enabled: '0',
    wa_contact_enabled: '0',
    wa_contact_number: '',
    wa_contact_message: 'Merhaba, {urun} hakkında bilgi almak istiyorum.',
    wa_contact_btn_text: 'WhatsApp ile Sipariş Ver',
    // WhatsApp ayarlari
    wa_enabled: '0',
    wa_api_url: 'https://graph.facebook.com/v21.0',
    wa_phone_id: '',
    wa_token: '',
    wa_payment_reminder_enabled: '0',
    wa_payment_reminder_delay: '60',
    wa_payment_reminder_message: 'Merhaba {name}, #{order_id} numarali siparisiniz icin odeme bekleniyor. Toplam: {total} TL. Havale/EFT ile odemenizi yaparak siparisinizi onaylayabilirsiniz. IBAN: {iban}',
    wa_abandoned_cart_enabled: '0',
    wa_abandoned_cart_delay: '30',
    wa_abandoned_cart_message: 'Merhaba {name}, sepetinizde {count} urun kaldi. Siparisinizi tamamlamayi unutmayin! {site_url}'
  };

  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(defaultSettings)) {
    insertSetting.run(key, value);
  }

  // Create default admin
  const adminExists = db.prepare('SELECT id FROM users WHERE is_admin = 1').get();
  if (!adminExists) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO users (name, email, password, is_admin) VALUES (?, ?, ?, 1)')
      .run('Admin', 'admin@flavora.com', hash);
  }
}

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  rows.forEach(row => { settings[row.key] = row.value; });
  return settings;
}

module.exports = { db, initDatabase, getSettings };
