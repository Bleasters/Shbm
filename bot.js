const { chromium } = require('playwright');
const TelegramBot = require('node-telegram-bot-api');
const http = require('http');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || 'BURAYA_TOKEN';
const CHAT_ID = process.env.CHAT_ID || 'BURAYA_CHAT_ID';

// Telegram bot (polling mode)
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// HTTP server (Railway için)
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`
    <h1>🤖 Bot Çalışıyor!</h1>
    <p>Son kontrol: ${new Date().toLocaleString('tr-TR')}</p>
    <p>Aktif aramalar: ${searches.length}</p>
  `);
}).listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server ${PORT} portunda başladı`);
  initializeBot();
});

// Global değişkenler
let searches = [];
let seenListings = new Map();
let intervals = new Map();
let isRunning = false;

function log(message) {
  const time = new Date().toLocaleString('tr-TR');
  console.log(`[${time}] ${message}`);
}

// Telegram mesaj gönder
async function sendMessage(text, options = {}) {
  try {
    await bot.sendMessage(CHAT_ID, text, { 
      parse_mode: 'HTML',
      ...options
    });
  } catch (error) {
    log(`Telegram hatası: ${error.message}`);
  }
}

// Sahibinden'den ilanları çek
async function fetchListings(searchUrl) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'tr-TR',
      timezoneId: 'Europe/Istanbul'
    });

    const page = await context.newPage();
    
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined
      });
    });
    
    log(`URL açılıyor: ${searchUrl}`);
    
    await page.goto(searchUrl, { 
      waitUntil: 'domcontentloaded',
      timeout: 90000
    });

    // Daha uzun bekle
    await page.waitForTimeout(8000);

    // DEBUG: Sayfa başlığını kontrol et
    const title = await page.title();
    log(`Sayfa başlığı: ${title}`);

    // DEBUG: İlan elementlerini ara
    const hasItems = await page.evaluate(() => {
      const tr = document.querySelectorAll('tr.searchResultsItem');
      const ul = document.querySelectorAll('ul.searchResultsItem');
      const table = document.querySelectorAll('table.searchResultsTable');
      
      console.log('TR elementi:', tr.length);
      console.log('UL elementi:', ul.length);
      console.log('TABLE elementi:', table.length);
      
      return {
        tr: tr.length,
        ul: ul.length,
        table: table.length,
        hasContent: document.body.innerHTML.length
      };
    });
    
    log(`Debug: TR=${hasItems.tr}, UL=${hasItems.ul}, TABLE=${hasItems.table}, Content=${hasItems.hasContent} bytes`);

    // Farklı selector'ları dene
    const listings = await page.evaluate(() => {
      const items = [];
      
      // Yöntem 1: TR elementi
      let rows = document.querySelectorAll('tr.searchResultsItem');
      
      // Yöntem 2: UL elementi (mobil)
      if (rows.length === 0) {
        rows = document.querySelectorAll('ul.searchResultsItem li');
      }
      
      // Yöntem 3: Genel arama
      if (rows.length === 0) {
        rows = document.querySelectorAll('[class*="searchResult"]');
      }
      
      rows.forEach(row => {
        // İlan linki bul
        const link = row.querySelector('a[href*="/ilan/"]') || 
                     row.querySelector('a[href*="sahibinden.com"]');
        
        if (!link) return;
        
        let url = link.href;
        
        // Relative URL'i düzelt
        if (!url.startsWith('http')) {
          url = 'https://www.sahibinden.com' + url;
        }
        
        const id = url.match(/\/(\d+)$/)?.[1] || url.match(/ilan\/\w+-(\d+)/)?.[1];
        if (!id) return;

        // Başlık
        const title = link.textContent?.trim() || 
                     row.querySelector('.classifiedTitle')?.textContent?.trim() ||
                     row.querySelector('[class*="title"]')?.textContent?.trim() ||
                     'Başlık yok';

        // Fiyat
        const price = row.querySelector('.searchResultsPriceValue')?.textContent?.trim() ||
                     row.querySelector('[class*="price"]')?.textContent?.trim() ||
                     '';

        // Konum
        const location = row.querySelector('.searchResultsLocationValue')?.textContent?.trim() ||
                        row.querySelector('[class*="location"]')?.textContent?.trim() ||
                        '';

        // Tarih
        const date = row.querySelector('.searchResultsDateValue span')?.getAttribute('title') ||
                    row.querySelector('.searchResultsDateValue')?.textContent?.trim() ||
                    row.querySelector('[class*="date"]')?.textContent?.trim() ||
                    '';

        items.push({ id, title, price, location, date, url });
      });

      return items;
    });

    // DEBUG: Screenshot al (opsiyonel)
    // await page.screenshot({ path: 'debug.png', fullPage: true });

    await browser.close();
    
    log(`${listings.length} ilan bulundu`);
    
    // İlk 3 ilanı logla (debug)
    if (listings.length > 0) {
      log(`İlk ilan: ${JSON.stringify(listings[0])}`);
    }
    
    return listings;

  } catch (error) {
    await browser.close();
    log(`Hata: ${error.message}`);
    log(`Stack: ${error.stack}`);
    return [];
  }
}

// Yeni ilanları kontrol et
async function checkNewListings(search, manualCheck = false) {
  try {
    const listings = await fetchListings(search.url);
    
    if (listings.length === 0) {
      log('İlan bulunamadı');
      if (manualCheck) {
        await sendMessage('⚠️ İlan bulunamadı veya sayfa yüklenemedi.');
      }
      return;
    }

    const searchKey = search.url;
    
    if (!seenListings.has(searchKey)) {
      seenListings.set(searchKey, new Set(listings.map(l => l.id)));
      log(`${listings.length} ilan ilk defa kaydedildi`);
      if (manualCheck) {
        await sendMessage(`✅ ${listings.length} mevcut ilan bulundu ve kaydedildi.`);
      }
      return;
    }

    const seen = seenListings.get(searchKey);
    const newListings = listings.filter(l => !seen.has(l.id));

    if (newListings.length > 0) {
      log(`🎉 ${newListings.length} YENİ İLAN BULUNDU!`);
      
      for (const listing of newListings) {
        const message = 
          `🔔 <b>YENİ İLAN!</b>\n\n` +
          `📌 <b>${listing.title}</b>\n` +
          `💰 ${listing.price || 'Belirtilmemiş'}\n` +
          `📍 ${listing.location || ''}\n` +
          `🕐 ${listing.date || ''}\n\n` +
          `🔗 ${listing.url}`;
        
        await sendMessage(message);
        seen.add(listing.id);
        await new Promise(r => setTimeout(r, 2000));
      }
    } else {
      log('Yeni ilan yok');
      if (manualCheck) {
        await sendMessage('ℹ️ Yeni ilan yok.');
      }
    }

  } catch (error) {
    log(`Kontrol hatası: ${error.message}`);
    if (manualCheck) {
      await sendMessage(`❌ Hata: ${error.message}`);
    }
  }
}

// Periyodik kontrol başlat
function startPeriodicCheck(search, index) {
  if (intervals.has(index)) {
    clearInterval(intervals.get(index));
  }

  checkNewListings(search);
  
  const interval = setInterval(() => {
    log(`--- Kontrol ${index + 1} başlıyor ---`);
    checkNewListings(search);
  }, search.interval * 60 * 1000);
  
  intervals.set(index, interval);
}

// Tüm kontrolleri durdur
function stopAllChecks() {
  intervals.forEach(interval => clearInterval(interval));
  intervals.clear();
  isRunning = false;
}

// Tüm kontrolleri başlat
function startAllChecks() {
  stopAllChecks();
  
  if (searches.length === 0) {
    return false;
  }

  searches.forEach((search, index) => {
    startPeriodicCheck(search, index);
  });
  
  isRunning = true;
  return true;
}

// ===== TELEGRAM KOMUTLARI =====

// /start komutu
bot.onText(/\/start/, async (msg) => {
  const welcomeMsg = 
    `🤖 <b>Sahibinden.com Bot'a Hoş Geldiniz!</b>\n\n` +
    `📋 <b>Komutlar:</b>\n\n` +
    `/ekle - Yeni arama URL'si ekle\n` +
    `/liste - Tüm aramaları listele\n` +
    `/yenile - Şimdi kontrol et\n` +
    `/basla - Botu başlat\n` +
    `/durdur - Botu durdur\n` +
    `/durum - Bot durumunu göster\n` +
    `/yardim - Yardım mesajı\n\n` +
    `💡 <b>İpucu:</b> Önce /ekle ile URL ekle, sonra /basla ile başlat!`;
  
  await sendMessage(welcomeMsg);
});

// /yardim komutu
bot.onText(/\/yardim/, async (msg) => {
  const helpMsg = 
    `📖 <b>Kullanım Kılavuzu</b>\n\n` +
    `1️⃣ <b>URL Eklemek:</b>\n` +
    `/ekle komutunu kullan\n` +
    `Örnek: Sahibinden.com'da arama yap, URL'i kopyala\n\n` +
    `2️⃣ <b>Kontrol Süresi:</b>\n` +
    `Dakika cinsinden gir (örn: 5)\n\n` +
    `3️⃣ <b>Botu Başlat:</b>\n` +
    `/basla komutu ile otomatik kontrol başlar\n\n` +
    `4️⃣ <b>Yeni İlan:</b>\n` +
    `Bot bulduğunda otomatik bildirim gönderir\n\n` +
    `💡 <b>İpuçları:</b>\n` +
    `• Çok sık kontrol etme (min 3 dakika)\n` +
    `• Birden fazla arama ekleyebilirsin\n` +
    `• /yenile ile anlık kontrol yapabilirsin`;
  
  await sendMessage(helpMsg);
});

// /ekle komutu - URL ekleme modu
bot.onText(/\/ekle/, async (msg) => {
  await sendMessage(
    `🔗 <b>Yeni Arama Ekle</b>\n\n` +
    `1️⃣ Sahibinden.com'da arama yap\n` +
    `2️⃣ URL'i kopyala ve buraya gönder\n` +
    `3️⃣ Kontrol süresini (dakika) gönder\n\n` +
    `Örnek URL:\n` +
    `<code>https://www.sahibinden.com/kiralik-daire/istanbul</code>\n\n` +
    `İptal için /iptal yaz`
  );
  
  // URL bekleme modu
  const urlListener = bot.once('message', async (urlMsg) => {
    if (urlMsg.text === '/iptal') {
      await sendMessage('❌ İptal edildi.');
      return;
    }
    
    const url = urlMsg.text;
    
    if (!url.includes('sahibinden.com')) {
      await sendMessage('❌ Geçersiz URL! Sahibinden.com linki gönder.');
      return;
    }
    
    await sendMessage(`✅ URL kaydedildi!\n\nŞimdi kontrol süresini gir (dakika):\nÖrnek: 5`);
    
    // Süre bekleme modu
    bot.once('message', async (intervalMsg) => {
      if (intervalMsg.text === '/iptal') {
        await sendMessage('❌ İptal edildi.');
        return;
      }
      
      const interval = parseInt(intervalMsg.text);
      
      if (isNaN(interval) || interval < 1) {
        await sendMessage('❌ Geçersiz süre! 1 veya daha büyük bir sayı gir.');
        return;
      }
      
      const newSearch = {
        id: Date.now(),
        url: url,
        interval: interval
      };
      
      searches.push(newSearch);
      
      await sendMessage(
        `✅ <b>Arama Eklendi!</b>\n\n` +
        `🔗 URL: ${url}\n` +
        `⏱ Kontrol: Her ${interval} dakika\n\n` +
        `Bot çalışıyorsa otomatik başlayacak.\n` +
        `Bot duruyorsa /basla ile başlat!`
      );
      
      // Bot çalışıyorsa yeni aramayı başlat
      if (isRunning) {
        const index = searches.length - 1;
        startPeriodicCheck(newSearch, index);
        await sendMessage('🚀 Yeni arama için otomatik kontrol başlatıldı!');
      }
      
      log(`Yeni arama eklendi: ${url} (${interval} dk)`);
    });
  });
});

// /liste komutu - Tüm aramaları listele
bot.onText(/\/liste/, async (msg) => {
  if (searches.length === 0) {
    await sendMessage('📋 Henüz arama eklenmemiş.\n\n/ekle komutu ile ekleyebilirsin!');
    return;
  }
  
  for (let i = 0; i < searches.length; i++) {
    const search = searches[i];
    const message = 
      `📍 <b>Arama ${i + 1}</b>\n\n` +
      `🔗 ${search.url}\n` +
      `⏱ Her ${search.interval} dakika\n` +
      `🆔 ID: ${search.id}`;
    
    const keyboard = {
      inline_keyboard: [[
        { text: '🗑 Sil', callback_data: `delete_${search.id}` }
      ]]
    };
    
    await sendMessage(message, { reply_markup: keyboard });
    await new Promise(r => setTimeout(r, 500));
  }
});

// Silme butonu callback
bot.on('callback_query', async (query) => {
  const data = query.data;
  
  if (data.startsWith('delete_')) {
    const searchId = parseInt(data.replace('delete_', ''));
    const index = searches.findIndex(s => s.id === searchId);
    
    if (index === -1) {
      await bot.answerCallbackQuery(query.id, { text: '❌ Arama bulunamadı!' });
      return;
    }
    
    // Interval'i durdur
    if (intervals.has(index)) {
      clearInterval(intervals.get(index));
      intervals.delete(index);
    }
    
    // Aramayı sil
    const deletedSearch = searches.splice(index, 1)[0];
    seenListings.delete(deletedSearch.url);
    
    // Mesajı güncelle
    await bot.editMessageText(
      `✅ <b>Arama Silindi!</b>\n\n🔗 ${deletedSearch.url}`,
      {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        parse_mode: 'HTML'
      }
    );
    
    await bot.answerCallbackQuery(query.id, { text: '✅ Silindi!' });
    
    log(`Arama silindi: ${deletedSearch.url}`);
    
    // Kalan aramaları yeniden indexle
    if (isRunning && searches.length > 0) {
      startAllChecks();
    } else if (searches.length === 0) {
      isRunning = false;
      await sendMessage('⚠️ Tüm aramalar silindi. Bot durduruldu.');
    }
  }
});

// /yenile komutu - Manuel kontrol
bot.onText(/\/yenile/, async (msg) => {
  if (searches.length === 0) {
    await sendMessage('❌ Henüz arama eklenmemiş!\n\n/ekle komutu ile ekle.');
    return;
  }
  
  await sendMessage('🔄 Tüm aramalar kontrol ediliyor...');
  
  for (let i = 0; i < searches.length; i++) {
    await sendMessage(`🔍 Arama ${i + 1} kontrol ediliyor...`);
    await checkNewListings(searches[i], true);
    await new Promise(r => setTimeout(r, 2000));
  }
  
  await sendMessage('✅ Tüm aramalar kontrol edildi!');
});

// /basla komutu
bot.onText(/\/basla/, async (msg) => {
  if (searches.length === 0) {
    await sendMessage('❌ Önce /ekle ile arama eklemen gerekiyor!');
    return;
  }
  
  if (isRunning) {
    await sendMessage('ℹ️ Bot zaten çalışıyor!');
    return;
  }
  
  if (startAllChecks()) {
    await sendMessage(
      `🚀 <b>Bot Başlatıldı!</b>\n\n` +
      `📊 ${searches.length} arama aktif\n` +
      `🔔 Yeni ilanlar otomatik bildirilecek\n\n` +
      `Komutlar: /durdur /liste /yenile`
    );
    log('Bot başlatıldı');
  }
});

// /durdur komutu
bot.onText(/\/durdur/, async (msg) => {
  if (!isRunning) {
    await sendMessage('ℹ️ Bot zaten durmuş durumda.');
    return;
  }
  
  stopAllChecks();
  await sendMessage('⏸ Bot durduruldu.\n\n/basla ile tekrar başlatabilirsin.');
  log('Bot durduruldu');
});

// /durum komutu
bot.onText(/\/durum/, async (msg) => {
  const statusMsg = 
    `📊 <b>Bot Durumu</b>\n\n` +
    `🤖 Durum: ${isRunning ? '✅ Çalışıyor' : '⏸ Durmuş'}\n` +
    `📋 Arama sayısı: ${searches.length}\n` +
    `🕐 Uptime: ${process.uptime().toFixed(0)} saniye\n` +
    `💾 Memory: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB\n\n` +
    (searches.length > 0 ? 
      `<b>Aktif Aramalar:</b>\n` + 
      searches.map((s, i) => `${i + 1}. Her ${s.interval} dk kontrol`).join('\n') 
      : '');
  
  await sendMessage(statusMsg);
});

// Bot başlatma
function initializeBot() {
  log('🚀 Telegram Bot başlatılıyor...');
  sendMessage('🤖 Bot yeniden başlatıldı!\n\n/start ile komutları görebilirsin.');
}

// Hata yakalama
process.on('unhandledRejection', (error) => {
  log(`Yakalanmamış hata: ${error.message}`);
});

bot.on('polling_error', (error) => {
  log(`Polling hatası: ${error.message}`);
});