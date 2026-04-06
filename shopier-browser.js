/**
 * Shopier Browser Checkout - Full Payment Flow with 3D Secure Support
 * Customer never leaves our site - 3DS SMS code entered on our page
 */

const { connect } = require("puppeteer-real-browser");
const CHROME_PATH = "/root/.cache/puppeteer/chrome/linux-146.0.7680.153/chrome-linux64/chrome";

// Active 3D Secure sessions (kept alive for SMS entry)
const activeSessions = {};

/**
 * Process full payment on Shopier via headless browser
 */
async function processPayment(shopierProductId, buyer, card) {
  process.env.CHROME_PATH = CHROME_PATH;

  const nameParts = (buyer.name || "").split(" ");
  const firstName = nameParts[0] || "Musteri";
  const lastName = nameParts.slice(1).join(" ") || ".";
  const phone = (buyer.phone || "").replace(/\D/g, "").replace(/^0/, "").substring(0, 10);
  const address = buyer.address || buyer.city || "Istanbul";
  const email = buyer.email || "musteri@modaflavora.com";
  const cardHolder = card.holder || (firstName + " " + lastName);
  const orderId = buyer.orderId;

  let browser;
  try {
    const t0 = Date.now();
    const log = function(msg) { console.log("[Shopier] " + msg + " (" + (Date.now() - t0) + "ms)"); };

    var result = await connect({
      headless: false,
      turnstile: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    browser = result.browser;
    var page = result.page;

    // === STEP 1: Product page + CF bypass ===
    log("Urun sayfasi: " + shopierProductId);
    await page.goto("https://www.shopier.com/" + shopierProductId, { waitUntil: "networkidle2", timeout: 45000 });

    for (var i = 0; i < 15; i++) {
      var t = await page.title();
      if (!t.toLowerCase().includes("moment") && !t.toLowerCase().includes("just")) break;
      await new Promise(function(r) { setTimeout(r, 1000); });
    }

    if ((await page.title()).toLowerCase().includes("moment")) {
      throw new Error("Cloudflare bypass basarisiz");
    }
    log("CF gecildi");

    // === STEP 2: Click Hemen al ===
    // First check if button exists
    var btnInfo = await page.evaluate(function() {
      var btns = Array.from(document.querySelectorAll("button"));
      var buyTexts = ["Hemen al", "Siparişi tamamla", "Sipari\u015fi tamamla", "Satın al", "Buy now"];
      var found = null;
      for (var k = 0; k < btns.length; k++) {
        var txt = btns[k].textContent.trim();
        for (var m = 0; m < buyTexts.length; m++) {
          if (txt === buyTexts[m]) { found = txt; break; }
        }
        if (found) break;
      }
      return {
        found: found,
        allButtons: btns.map(function(b) { return b.textContent.trim().substring(0, 30); }),
        url: location.href,
        title: document.title
      };
    });
    log("Sayfa durumu: " + JSON.stringify(btnInfo));

    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(function() { return null; }),
      page.evaluate(function() {
        var buyTexts = ["Hemen al", "Siparişi tamamla", "Sipari\u015fi tamamla", "Satın al", "Buy now"];
        var btns = Array.from(document.querySelectorAll("button"));
        for (var k = 0; k < btns.length; k++) {
          var txt = btns[k].textContent.trim();
          for (var m = 0; m < buyTexts.length; m++) {
            if (txt === buyTexts[m]) { btns[k].click(); return true; }
          }
        }
        return false;
      })
    ]);
    log("Satin al tiklandi");

    // Debug: check where we are after click
    var afterClick = await page.evaluate(function() {
      return { url: location.href, title: document.title, hasEmail: !!document.querySelector("#formControlEmail") };
    });
    log("Hemen al sonrasi: " + JSON.stringify(afterClick));

    // === STEP 3: Fill shipping form ===
    await page.waitForSelector("#formControlEmail", { timeout: 30000 }).catch(function(e) {
      // Extra debug before throwing
      return page.evaluate(function() {
        return {
          url: location.href,
          title: document.title,
          bodyText: document.body ? document.body.innerText.substring(0, 500) : 'no body',
          inputs: Array.from(document.querySelectorAll("input")).map(function(i) { return i.id || i.name || i.type; })
        };
      }).then(function(dbg) {
        console.log("[Shopier] formControlEmail bulunamadi debug:", JSON.stringify(dbg));
        throw e;
      });
    });

    await page.click("#formControlEmail", { clickCount: 3 });
    await page.type("#formControlEmail", email, { delay: 1 });

    await page.click("#formControlPhone", { clickCount: 3 });
    await page.type("#formControlPhone", phone, { delay: 1 });

    await page.evaluate(function(ph) {
      var el = document.querySelector("#formControlPhoneHidden");
      if (el) {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(el, ph);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, "90" + phone);

    await page.click("#formControlName", { clickCount: 3 });
    await page.type("#formControlName", firstName, { delay: 1 });
    await page.click("#formControlSurName", { clickCount: 3 });
    await page.type("#formControlSurName", lastName, { delay: 1 });

    // Fill address - try visible input #formControlAddress first, then textarea
    var addrInput = await page.$("#formControlAddress");
    if (addrInput) {
      await page.click("#formControlAddress", { clickCount: 3 });
      await page.type("#formControlAddress", address, { delay: 1 });
    } else {
      await page.evaluate(function(addr) {
        var el = document.querySelector("#address-text") || document.querySelector("textarea[placeholder=Adres]");
        if (el) {
          var proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, "value").set.call(el, addr);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }, address);
    }

    await new Promise(function(r) { setTimeout(r, 300); });

    // === STEP 3b: Fill İl (state) and İlçe (city) via hidden selects ===
    // Shopier uses hidden <select id="state"> and <select id="city"> behind custom dropdown buttons
    var stateResult = await page.evaluate(function() {
      var sel = document.querySelector("#state");
      if (!sel) return { found: false, msg: "state select yok" };
      // Find Istanbul
      for (var j = 0; j < sel.options.length; j++) {
        if (sel.options[j].value === "İstanbul" || sel.options[j].text === "İstanbul") {
          sel.selectedIndex = j;
          var nativeSet = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value");
          if (nativeSet && nativeSet.set) nativeSet.set.call(sel, sel.options[j].value);
          else sel.value = sel.options[j].value;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          sel.dispatchEvent(new Event("input", { bubbles: true }));
          // Also update the visible button text
          var btns = document.querySelectorAll("button.dropdown-toggle.select-btn");
          for (var k = 0; k < btns.length; k++) {
            if (btns[k].textContent.trim() === "İl") {
              btns[k].textContent = "İstanbul";
              break;
            }
          }
          return { found: true, value: "İstanbul" };
        }
      }
      // Fallback: first non-empty option
      if (sel.options.length > 1) {
        sel.selectedIndex = 1;
        sel.value = sel.options[1].value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return { found: true, value: sel.options[1].text, fallback: true };
      }
      return { found: false, optCount: sel.options.length };
    });
    log("Il secimi: " + JSON.stringify(stateResult));

    // Wait for city options to load after state change
    await new Promise(function(r) { setTimeout(r, 1500); });

    // Select first available İlçe
    var cityResult = await page.evaluate(function() {
      var sel = document.querySelector("#city");
      if (!sel) return { found: false, msg: "city select yok" };
      // Wait might not have loaded options yet, check
      if (sel.options.length <= 1) return { found: false, msg: "city options bos", optCount: sel.options.length };
      sel.selectedIndex = 1;
      var nativeSet = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value");
      if (nativeSet && nativeSet.set) nativeSet.set.call(sel, sel.options[1].value);
      else sel.value = sel.options[1].value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      sel.dispatchEvent(new Event("input", { bubbles: true }));
      // Update visible button text
      var btns = document.querySelectorAll("button.dropdown-toggle.select-btn");
      for (var k = 0; k < btns.length; k++) {
        if (btns[k].textContent.trim() === "İlçe") {
          btns[k].textContent = sel.options[1].text;
          break;
        }
      }
      return { found: true, value: sel.options[1].text };
    });
    log("Ilce secimi: " + JSON.stringify(cityResult));

    // If city options weren't loaded, retry after more wait
    if (!cityResult.found) {
      await new Promise(function(r) { setTimeout(r, 2000); });
      cityResult = await page.evaluate(function() {
        var sel = document.querySelector("#city");
        if (!sel || sel.options.length <= 1) return { found: false };
        sel.selectedIndex = 1;
        sel.value = sel.options[1].value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        var btns = document.querySelectorAll("button.dropdown-toggle.select-btn");
        for (var k = 0; k < btns.length; k++) {
          if (btns[k].textContent.trim() === "İlçe") {
            btns[k].textContent = sel.options[1].text;
            break;
          }
        }
        return { found: true, value: sel.options[1].text, retry: true };
      });
      log("Ilce secimi (retry): " + JSON.stringify(cityResult));
    }

    await new Promise(function(r) { setTimeout(r, 500); });
    log("Shipping formu dolduruldu (il/ilce dahil)");

    // === STEP 4: Submit shipping ===
    await page.evaluate(function() {
      var btn = document.querySelector("button.btn-form-submit");
      if (btn) btn.click();
    });

    for (var i = 0; i < 40; i++) {
      await new Promise(function(r) { setTimeout(r, 500); });
      var curUrl = page.url();
      if (curUrl.includes("/s/payment/")) break;
      // Retry click if still on shipping page after 5s
      if (i === 10) {
        await page.evaluate(function() {
          var btn = document.querySelector("button.btn-form-submit");
          if (btn) btn.click();
        }).catch(function() {});
      }
    }

    if (!page.url().includes("/s/payment/")) {
      // Debug: capture page state before throwing error
      var debugInfo = await page.evaluate(function() {
        var alerts = document.querySelectorAll(".alert, .text-danger, [class*=error], .invalid-feedback");
        var msgs = [];
        for (var i = 0; i < alerts.length; i++) {
          var t = alerts[i].textContent.trim();
          if (t) msgs.push(t.substring(0, 100));
        }
        return { url: location.href, title: document.title, errors: msgs };
      }).catch(function() { return { url: "unknown" }; });
      log("Shipping debug: " + JSON.stringify(debugInfo));
      throw new Error("Odeme sayfasina ulasilamadi: " + (debugInfo.errors && debugInfo.errors.length ? debugInfo.errors.join("; ") : page.url()));
    }
    log("Odeme sayfasi acildi");

    await page.waitForSelector("#formControlCardNumber", { timeout: 10000 });
    await new Promise(function(r) { setTimeout(r, 1000); });

    // === STEP 5: Fill card details ===
    await page.click("#formControlCardName", { clickCount: 3 });
    await page.type("#formControlCardName", cardHolder, { delay: 1 });

    await page.click("#formControlCardNumber", { clickCount: 3 });
    await page.type("#formControlCardNumber", card.number.replace(/\s/g, ""), { delay: 1 });

    await page.click("#formControlCardDate", { clickCount: 3 });
    await page.type("#formControlCardDate", card.expiry, { delay: 1 });

    await page.click("#formControlCardCCV", { clickCount: 3 });
    await page.type("#formControlCardCCV", card.cvv, { delay: 1 });

    await new Promise(function(r) { setTimeout(r, 500); });
    log("Kart bilgileri girildi");

    // === STEP 6: Intercept 3D POST (block it so customer's browser can use it) ===
    var threeDsPostData = null;
    var interceptActive = false;
    try {
      await page.setRequestInterception(true);
      interceptActive = true;
    } catch(e) {
      log("Request interception desteklenmiyor: " + e.message);
    }

    if (interceptActive) {
      page.on('request', function(req) {
        if (threeDsPostData) {
          try { req.abort(); } catch(e) {}
          return;
        }
        var rUrl = req.url();
        // Block 3D Secure POST to bank - capture data for customer redirect
        if (req.method() === 'POST' && !rUrl.includes('shopier.com') && !rUrl.includes('google') && !rUrl.includes('facebook') && !rUrl.includes('analytics') && !rUrl.includes('cloudflare')) {
          try {
            threeDsPostData = { url: rUrl, body: req.postData() || '' };
            log("3D POST yakalandi ve ENGELLENDI: " + rUrl + " (" + threeDsPostData.body.length + " bytes)");
            req.abort('blockedbyclient');
          } catch(e) {
            try { req.continue(); } catch(e2) {}
          }
          return;
        }
        try { req.continue(); } catch(e) {}
      });
    } else {
      // Fallback: passive capture (puppeteer consumes the transaction too)
      page.on('request', function(req) {
        var rUrl = req.url();
        if (req.method() === 'POST' && !rUrl.includes('shopier.com') && !rUrl.includes('google') && !rUrl.includes('facebook') && !rUrl.includes('analytics') && !threeDsPostData) {
          try { threeDsPostData = { url: rUrl, body: req.postData() || '' }; } catch(e) {}
        }
      });
    }

    await page.evaluate(function() {
      var btn = document.querySelector("button.btn-form-submit");
      if (btn) btn.click();
    });
    log("Odeme gonderildi, sonuc bekleniyor...");

    // === STEP 7: Wait for result or 3D Secure ===
    for (var i = 0; i < 20; i++) {
      await new Promise(function(r) { setTimeout(r, 1000); });

      // 3D POST was captured and blocked - customer will handle 3D
      if (threeDsPostData && interceptActive) {
        log("3D Secure: musteri tarayicisina yonlendirilecek");
        await browser.close();
        return { success: false, needs3ds: true, url: threeDsPostData.url, postData: threeDsPostData };
      }

      var url = page.url();

      // Success without 3D Secure
      if (url.includes("/s/order/") || url.includes("/s/confirmation/") || url.includes("tamamland")) {
        log("Odeme basarili (3D Secure yok)");
        await browser.close();
        return { success: true };
      }

      // 3D Secure detected via navigation (fallback - interception didn't work)
      if (!url.includes("shopier.com") && !url.includes("/s/payment/")) {
        log("3D Secure tespit edildi (navigasyon): " + url);
        if (orderId) {
          activeSessions[orderId] = { browser: browser, page: page, startTime: Date.now() };
          setTimeout(function() {
            if (activeSessions[orderId]) {
              try { activeSessions[orderId].browser.close(); } catch(e) {}
              delete activeSessions[orderId];
            }
          }, 5 * 60 * 1000);
        }
        return { success: false, needs3ds: true, url: url, postData: threeDsPostData };
      }
    }

    // Timeout - check for errors on payment page
    var finalUrl = page.url();
    if (finalUrl.includes("/s/payment/")) {
      var errorText = await page.evaluate(function() {
        var els = document.querySelectorAll(".alert, .notification-bar, .modal.show, [class*=error]");
        for (var i = 0; i < els.length; i++) {
          var t = els[i].textContent.trim();
          if (t && els[i].offsetParent !== null) return t.substring(0, 200);
        }
        return null;
      }).catch(function() { return null; });

      await browser.close();
      return { success: false, error: errorText || "Odeme islenemedi. Kart bilgilerinizi kontrol edin." };
    }

    if (finalUrl.includes("/s/order/") || finalUrl.includes("/s/confirmation/") || finalUrl.includes("tamamland")) {
      await browser.close();
      return { success: true };
    }

    await browser.close();
    log("Bilinmeyen durum: " + finalUrl);
    return { success: false, error: "Odeme sonucu alinamadi. Lutfen tekrar deneyin." };

  } catch (err) {
    console.error("[Shopier] Hata:", err.message);
    if (browser && !activeSessions[orderId]) {
      await browser.close().catch(function() {});
    }
    return { success: false, error: err.message };
  }
}

/**
 * Submit 3D Secure SMS code
 */
async function submitSmsCode(orderId, smsCode) {
  var session = activeSessions[orderId];
  if (!session) {
    return { success: false, error: "3D Secure oturumu bulunamadi veya suresi doldu." };
  }

  var page = session.page;
  var browser = session.browser;

  try {
    console.log("[Shopier] 3D SMS kodu giriliyor: " + orderId);

    // Find SMS/OTP input field on 3D Secure page
    // Turkish banks typically use these selectors
    var inputFound = await page.evaluate(function(code) {
      // Try common 3D Secure input selectors
      var selectors = [
        "input[type=text]", "input[type=tel]", "input[type=number]", "input[type=password]",
        "input[name*=otp]", "input[name*=sms]", "input[name*=code]", "input[name*=pin]",
        "input[name*=Otp]", "input[name*=Sms]", "input[name*=Code]", "input[name*=Pin]",
        "input[id*=otp]", "input[id*=sms]", "input[id*=code]", "input[id*=pin]",
        "input[placeholder*=kod]", "input[placeholder*=SMS]", "input[placeholder*=Kod]",
        "input[autocomplete=one-time-code]"
      ];

      for (var i = 0; i < selectors.length; i++) {
        var inputs = document.querySelectorAll(selectors[i]);
        for (var j = 0; j < inputs.length; j++) {
          var inp = inputs[j];
          if (inp.offsetParent !== null && !inp.disabled && inp.type !== "hidden") {
            inp.focus();
            inp.value = "";
            // Use native setter for React compatibility
            var nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
            nativeSet.call(inp, code);
            inp.dispatchEvent(new Event("input", { bubbles: true }));
            inp.dispatchEvent(new Event("change", { bubbles: true }));
            return { found: true, selector: selectors[i], id: inp.id, name: inp.name };
          }
        }
      }
      return { found: false };
    }, smsCode).catch(function() { return { found: false }; });

    console.log("[Shopier] SMS input:", JSON.stringify(inputFound));

    if (!inputFound.found) {
      // Try using page.type on any visible text input
      var visibleInput = await page.evaluate(function() {
        var inputs = document.querySelectorAll("input");
        for (var i = 0; i < inputs.length; i++) {
          if (inputs[i].offsetParent !== null && inputs[i].type !== "hidden" && inputs[i].type !== "submit") {
            return true;
          }
        }
        return false;
      });

      if (visibleInput) {
        await page.keyboard.type(smsCode);
        inputFound = { found: true, method: "keyboard" };
      }
    }

    if (!inputFound.found) {
      return { success: false, error: "SMS kodu giriş alanı bulunamadı." };
    }

    await new Promise(function(r) { setTimeout(r, 500); });

    // Click submit/confirm button
    await page.evaluate(function() {
      var btns = document.querySelectorAll("button, input[type=submit], a[class*=btn]");
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        var text = (b.textContent || b.value || "").toLowerCase();
        if (b.offsetParent !== null && (text.includes("onayla") || text.includes("gonder") || text.includes("dogrula") || text.includes("submit") || text.includes("confirm") || text.includes("tamam") || text.includes("devam"))) {
          b.click();
          return true;
        }
      }
      // If no text match, click the first visible submit button
      for (var i = 0; i < btns.length; i++) {
        if (btns[i].offsetParent !== null && (btns[i].type === "submit" || btns[i].tagName === "BUTTON")) {
          btns[i].click();
          return true;
        }
      }
      return false;
    });

    console.log("[Shopier] 3D SMS submit tiklandi, sonuc bekleniyor...");

    // Wait for result (success or error)
    for (var i = 0; i < 30; i++) {
      await new Promise(function(r) { setTimeout(r, 1000); });
      var url = page.url();

      // Success - redirected to Shopier order confirmation
      if (url.includes("/s/order/") || url.includes("/s/confirmation/") || url.includes("tamamland") || url.includes("shopier.com")) {
        if (url.includes("/s/order/") || url.includes("/s/confirmation/") || url.includes("tamamland")) {
          console.log("[Shopier] 3D Secure basarili, odeme tamamlandi");
          await browser.close();
          delete activeSessions[orderId];
          return { success: true };
        }
        // Back on Shopier but not order page - might be processing
        if (url.includes("/s/payment/")) {
          // Check for error on payment page
          var payError = await page.evaluate(function() {
            var el = document.querySelector(".alert-danger, .notification-bar.show");
            return el ? el.textContent.trim().substring(0, 200) : null;
          }).catch(function() { return null; });

          if (payError) {
            await browser.close();
            delete activeSessions[orderId];
            return { success: false, error: payError };
          }
        }
      }
    }

    // Timeout - check final state
    var finalUrl = page.url();
    console.log("[Shopier] 3D Secure sonuc URL:", finalUrl);
    await browser.close();
    delete activeSessions[orderId];

    if (finalUrl.includes("/s/order/") || finalUrl.includes("/s/confirmation/") || finalUrl.includes("tamamland")) {
      return { success: true };
    }

    return { success: false, error: "3D Secure dogrulama zaman asimina ugradi." };

  } catch (err) {
    console.error("[Shopier] 3D SMS hata:", err.message);
    try { await browser.close(); } catch(e) {}
    delete activeSessions[orderId];
    return { success: false, error: err.message };
  }
}

/**
 * Check if a 3D Secure session exists for an order
 */
function has3dsSession(orderId) {
  return !!activeSessions[orderId];
}

module.exports = { processPayment, submitSmsCode, has3dsSession };
