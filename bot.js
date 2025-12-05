const TelegramBot = require('node-telegram-bot-api');
const http = require('http');
const https = require('https');
const { parseStringPromise } = require('xml2js');

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

// Varsayılan arama - otomobil ilanları
const DEFAULT_SEARCH = {
  id: Date.now(),
  url: 'https://www.sahibinden.com/otomobil?sorting=date_desc&utm_source=paylas&utm_medium=arama_sonuc&utm_campaign=sahibinden_paylas&utm_content=174536269',
  interval: 5
};

// Global değişkenler
let searches = [DEFAULT_SEARCH];
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

// URL'den RSS feed URL'si oluştur
function getRssFeedUrl(searchUrl) {
  // Zaten RSS ise olduğu gibi döndür
  if (searchUrl.includes('rss=true') || searchUrl.includes('.xml')) {
    return searchUrl;
  }
  
  // URL'e RSS parametresi ekle
  const separator = searchUrl.includes('?') ? '&' : '?';
  return `${searchUrl}${separator}rss=true`;
}

// RSS feed'i çek
async function fetchRssFeed(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        'Accept-Language': 'tr-TR,tr;q=0.9',
      }
    }, (res) => {
      let data = '';
      
      res.on('data', chunk => data += chunk);
      
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    }).on('error', reject);
  });
}

// RSS XML'i parse et
async function parseRss(xml) {
  try {
    const result = await parseStringPromise(xml);
    const items = result.rss?.channel?.[0]?.item || [];
    
    const listings = items.map(item => {
      const link = item.link?.[0] || '';
      const id = link.match(/\/(\d+)$/)?.[1] || link.match(/ilan\/\w+-(\d+)/)?.[1];
      
      const title = item.title?.[0] || '';
      const description = item.description?.[0] || '';
      const pubDate = item.pubDate?.[0] || '';
      
      // Description'dan fiyat ve konum çıkar
      let price = '';
      let location = '';
      
      if (description) {
        const priceMatch = description.match(/Fiyat:\s*([^<]+)/i);
        const locationMatch = description.match(/İl-İlçe:\s*([^<]+)/i);
        
        price = priceMatch ? priceMatch[1].trim() : '';
        location = locationMatch ? locationMatch[1].trim() : '';
      }
      
      return {
        id,
        title,
        price,
        location,
        date: pubDate,
        url: link
      };
    }).filter(item => item.id); // Sadece ID'si olanlar
    
    return listings;
  } catch (error) {
    log(`RSS parse hatası: ${error.message}`);
    return [];
  }
}

// Sahibinden'den ilanları çek (RSS)
async function fetchListings(searchUrl) {
  try {
    const rssUrl = getRssFeedUrl(searchUrl);
    log(`RSS feed açılıyor: ${rssUrl}`);
    
    const xml = await fetchRssFeed(rssUrl);
    const listings = await parseRss(xml);
    
    log(`${listings.length} ilan bulundu`);
    
    if (listings.length > 0) {
      log(`İlk ilan: ${listings[0].title.substring(0, 50)}...`);
    }
    
    return listings;
    
  } catch (error) {
    log(`Hata: ${error.message}`);
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
        await sendMessage('⚠️ İlan bulunamadı. URL geçerli mi kontrol et.');
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
    `🚗 Varsayılan arama aktif: Otomobil ilanları\n\n` +
    `📋 <b>Komutlar:</b>\n\n` +
    `/ekle - Yeni arama URL'si ekle\n` +
    `/liste - Tüm aramaları listele\n` +
    `/yenile - Şimdi kontrol et\n` +
    `/basla - Botu başlat\n` +
    `/durdur - Botu durdur\n` +
    `/durum - Bot durumunu göster\n` +
    `/yardim - Yardım mesajı\n\n` +
    `💡 <b>Otomatik başlatıldı!</b> /durdur ile durdurabilirsin.`;
  
  await sendMessage(welcomeMsg);
});

// /yardim komutu
bot.onText(/\/yardim/, async (msg) => {
  const helpMsg = 
    `📖 <b>Kullanım Kılavuzu</b>\n\n` +
    `<b>🔍 URL Nasıl Bulunur?</b>\n` +
    `1. Sahibinden.com'a git\n` +
    `2. İstediğin aramayı yap (kategori, filtreler)\n` +
    `3. Arama sonuç sayfasının URL'ini kopyala\n` +
    `4. /ekle ile bota gönder\n\n` +
    `<b>⚙️ Bot Nasıl Çalışır?</b>\n` +
    `• Bot RSS feed kullanır (hızlı ve güvenilir)\n` +
    `• Her X dakikada otomatik kontrol eder\n` +
    `• Yeni ilan bulunca anında bildirir\n\n` +
    `<b>💡 İpuçları:</b>\n` +
    `• Minimum 3 dakika kontrol süresi öner\n` +
    `• "Tarihe göre sırala" seçeneğini kullan\n` +
    `• /yenile ile anlık kontrol yapabilirsin\n` +
    `• Birden fazla arama ekleyebilirsin`;
  
  await sendMessage(helpMsg);
});

// /ekle komutu
bot.onText(/\/ekle/, async (msg) => {
  await sendMessage(
    `🔗 <b>Yeni Arama Ekle</b>\n\n` +
    `1️⃣ Sahibinden.com'da arama yap\n` +
    `2️⃣ URL'i kopyala ve buraya gönder\n` +
    `3️⃣ Kontrol süresini (dakika) gönder\n\n` +
    `<b>Örnek URL:</b>\n` +
    `<code>https://www.sahibinden.com/kiralik-daire/istanbul</code>\n\n` +
    `<b>Not:</b> RSS otomatik eklenir, endişelenme!\n\n` +
    `İptal için /iptal yaz`
  );
  
  bot.once('message', async (urlMsg) => {
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
        `⏱ Kontrol: Her ${interval} dakika\n` +
        `📡 Mod: RSS Feed (hızlı ve güvenilir)\n\n` +
        `Bot çalışıyorsa otomatik başlayacak.\n` +
        `Bot duruyorsa /basla ile başlat!`
      );
      
      if (isRunning) {
        const index = searches.length - 1;
        startPeriodicCheck(newSearch, index);
        await sendMessage('🚀 Yeni arama için otomatik kontrol başlatıldı!');
      }
      
      log(`Yeni arama eklendi: ${url} (${interval} dk)`);
    });
  });
});

// /liste komutu
bot.onText(/\/liste/, async (msg) => {
  if (searches.length === 0) {
    await sendMessage('📋 Henüz arama eklenmemiş.\n\n/ekle komutu ile ekleyebilirsin!');
    return;
  }
  
  for (let i = 0; i < searches.length; i++) {
    const search = searches[i];
    const isDefault = search.id === DEFAULT_SEARCH.id;
    
    const message = 
      `📍 <b>Arama ${i + 1}</b>${isDefault ? ' (Varsayılan 🚗)' : ''}\n\n` +
      `🔗 ${search.url.substring(0, 80)}...\n` +
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
    
    if (intervals.has(index)) {
      clearInterval(intervals.get(index));
      intervals.delete(index);
    }
    
    const deletedSearch = searches.splice(index, 1)[0];
    seenListings.delete(deletedSearch.url);
    
    await bot.editMessageText(
      `✅ <b>Arama Silindi!</b>\n\n🔗 ${deletedSearch.url.substring(0, 60)}...`,
      {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        parse_mode: 'HTML'
      }
    );
    
    await bot.answerCallbackQuery(query.id, { text: '✅ Silindi!' });
    
    log(`Arama silindi: ${deletedSearch.url}`);
    
    if (isRunning && searches.length > 0) {
      startAllChecks();
    } else if (searches.length === 0) {
      isRunning = false;
      await sendMessage('⚠️ Tüm aramalar silindi. Bot durduruldu.');
    }
  }
});

// /yenile komutu
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
      `📡 RSS Feed modu (hızlı ve güvenilir)\n` +
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
    `📡 Mod: RSS Feed\n` +
    `🕐 Uptime: ${Math.floor(process.uptime() / 60)} dakika\n` +
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
  
  // Otomatik başlat
  if (startAllChecks()) {
    sendMessage(
      `🤖 <b>Bot Otomatik Başlatıldı!</b>\n\n` +
      `🚗 Varsayılan arama: Otomobil ilanları\n` +
      `📡 RSS Feed modu aktif\n\n` +
      `/start ile tüm komutları görebilirsin.\n` +
      `/ekle ile yeni aramalar ekleyebilirsin!`
    );
    log('Varsayılan arama ile bot başlatıldı');
  }
}

// Hata yakalama
process.on('unhandledRejection', (error) => {
  log(`Yakalanmamış hata: ${error.message}`);
});

bot.on('polling_error', (error) => {
  log(`Polling hatası: ${error.message}`);
});