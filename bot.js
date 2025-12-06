const TelegramBot = require('node-telegram-bot-api');
const http = require('http');
const https = require('https');
const { parseStringPromise } = require('xml2js');
const { HttpsProxyAgent } = require('https-proxy-agent');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || 'BURAYA_TOKEN';
const CHAT_ID = process.env.CHAT_ID || 'BURAYA_CHAT_ID';

// Ücretsiz proxy rotasyonu
const FREE_PROXIES = [
  'http://proxy.toolip.io:31112',
  'http://proxy-pr.privoxy.org:8118',
  'http://proxy.fluxdesk.work:3128',
];

let currentProxyIndex = 0;

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
    <p>Proxy: ${FREE_PROXIES[currentProxyIndex]}</p>
  `);
}).listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server ${PORT} portunda başladı`);
  initializeBot();
});

// Varsayılan arama - otomobil ilanları
const DEFAULT_SEARCH = {
  id: Date.now(),
  url: 'https://www.sahibinden.com/otomobil?sorting=date_desc',
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
      disable_web_page_preview: true,
      ...options
    });
  } catch (error) {
    log(`Telegram hatası: ${error.message}`);
  }
}

// Proxy değiştir
function rotateProxy() {
  currentProxyIndex = (currentProxyIndex + 1) % FREE_PROXIES.length;
  log(`Proxy değiştirildi: ${FREE_PROXIES[currentProxyIndex]}`);
}

// URL'den RSS feed URL'si oluştur
function getRssFeedUrl(searchUrl) {
  if (searchUrl.includes('rss=true') || searchUrl.includes('.xml')) {
    return searchUrl;
  }
  
  const separator = searchUrl.includes('?') ? '&' : '?';
  return `${searchUrl}${separator}rss=true`;
}

// RSS feed'i çek (Proxy ile)
async function fetchRssFeed(url, retryCount = 0) {
  const maxRetries = FREE_PROXIES.length;
  
  return new Promise((resolve, reject) => {
    const proxyUrl = FREE_PROXIES[currentProxyIndex];
    
    let agent;
    try {
      agent = new HttpsProxyAgent(proxyUrl);
    } catch (e) {
      // Proxy hatası, direkt bağlan
      agent = undefined;
    }
    
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        'Accept-Language': 'tr-TR,tr;q=0.9',
        'Referer': 'https://www.sahibinden.com',
      },
      timeout: 15000
    };
    
    if (agent) {
      options.agent = agent;
    }
    
    const req = https.get(url, options, (res) => {
      let data = '';
      
      res.on('data', chunk => data += chunk);
      
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data);
        } else if (res.statusCode === 403 && retryCount < maxRetries) {
          log(`403 hatası, proxy değiştiriliyor... (${retryCount + 1}/${maxRetries})`);
          rotateProxy();
          setTimeout(() => {
            fetchRssFeed(url, retryCount + 1).then(resolve).catch(reject);
          }, 2000);
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });
    
    req.on('error', (error) => {
      if (retryCount < maxRetries) {
        log(`Bağlantı hatası, yeniden deneniyor... (${retryCount + 1}/${maxRetries})`);
        rotateProxy();
        setTimeout(() => {
          fetchRssFeed(url, retryCount + 1).then(resolve).catch(reject);
        }, 2000);
      } else {
        reject(error);
      }
    });
    
    req.on('timeout', () => {
      req.destroy();
      if (retryCount < maxRetries) {
        log(`Timeout, proxy değiştiriliyor... (${retryCount + 1}/${maxRetries})`);
        rotateProxy();
        setTimeout(() => {
          fetchRssFeed(url, retryCount + 1).then(resolve).catch(reject);
        }, 2000);
      } else {
        reject(new Error('Timeout'));
      }
    });
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
      
      let price = '';
      let location = '';
      
      if (description) {
        const priceMatch = description.match(/Fiyat:\s*([^<]+)/i) || 
                          description.match(/(\d{1,3}(?:\.\d{3})*(?:,\d{2})?\s*TL)/);
        const locationMatch = description.match(/İl-İlçe:\s*([^<]+)/i) ||
                             description.match(/([\w\sğüşıöçĞÜŞİÖÇ]+\/[\w\sğüşıöçĞÜŞİÖÇ]+)/);
        
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
    }).filter(item => item.id);
    
    return listings;
  } catch (error) {
    log(`RSS parse hatası: ${error.message}`);
    return [];
  }
}

// Sahibinden'den ilanları çek
async function fetchListings(searchUrl) {
  try {
    const rssUrl = getRssFeedUrl(searchUrl);
    log(`RSS feed açılıyor: ${rssUrl.substring(0, 80)}...`);
    log(`Kullanılan proxy: ${FREE_PROXIES[currentProxyIndex]}`);
    
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
        await sendMessage('⚠️ İlan bulunamadı. Tüm proxy\'ler denendi.');
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
          `🔗 <a href="${listing.url}">İlanı Görüntüle</a>`;
        
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

bot.onText(/\/start/, async (msg) => {
  const welcomeMsg = 
    `🤖 <b>Sahibinden.com Bot'a Hoş Geldiniz!</b>\n\n` +
    `🚗 Varsayılan arama aktif: Otomobil ilanları\n` +
    `🔐 Proxy koruması aktif\n\n` +
    `📋 <b>Komutlar:</b>\n\n` +
    `/ekle - Yeni arama URL'si ekle\n` +
    `/liste - Tüm aramaları listele\n` +
    `/yenile - Şimdi kontrol et\n` +
    `/basla - Botu başlat\n` +
    `/durdur - Botu durdur\n` +
    `/durum - Bot durumunu göster\n` +
    `/yardim - Yardım mesajı\n\n` +
    `💡 <b>Otomatik başlatıldı!</b>`;
  
  await sendMessage(welcomeMsg);
});

bot.onText(/\/yardim/, async (msg) => {
  const helpMsg = 
    `📖 <b>Kullanım Kılavuzu</b>\n\n` +
    `<b>🔍 URL Nasıl Bulunur?</b>\n` +
    `1. Sahibinden.com'a git\n` +
    `2. İstediğin aramayı yap\n` +
    `3. URL'i kopyala ve /ekle ile gönder\n\n` +
    `<b>⚙️ Bot Nasıl Çalışır?</b>\n` +
    `• RSS feed + Proxy kullanır\n` +
    `• Her X dakikada kontrol eder\n` +
    `• Yeni ilan bulunca bildirir\n\n` +
    `<b>💡 İpuçları:</b>\n` +
    `• Minimum 5 dakika öner\n` +
    `• "Tarihe göre sırala" kullan\n` +
    `• /yenile ile manuel kontrol`;
  
  await sendMessage(helpMsg);
});

bot.onText(/\/ekle/, async (msg) => {
  await sendMessage(
    `🔗 <b>Yeni Arama Ekle</b>\n\n` +
    `1️⃣ Sahibinden.com'da arama yap\n` +
    `2️⃣ URL'i kopyala ve buraya gönder\n` +
    `3️⃣ Kontrol süresini (dakika) gönder\n\n` +
    `İptal için /iptal yaz`
  );
  
  bot.once('message', async (urlMsg) => {
    if (urlMsg.text === '/iptal') {
      await sendMessage('❌ İptal edildi.');
      return;
    }
    
    const url = urlMsg.text;
    
    if (!url.includes('sahibinden.com')) {
      await sendMessage('❌ Geçersiz URL!');
      return;
    }
    
    await sendMessage(`✅ URL kaydedildi!\n\nKontrol süresi (dakika):`);
    
    bot.once('message', async (intervalMsg) => {
      if (intervalMsg.text === '/iptal') {
        await sendMessage('❌ İptal edildi.');
        return;
      }
      
      const interval = parseInt(intervalMsg.text);
      
      if (isNaN(interval) || interval < 1) {
        await sendMessage('❌ Geçersiz süre!');
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
        `🔗 URL: ${url.substring(0, 60)}...\n` +
        `⏱ Her ${interval} dakika\n\n` +
        `Bot çalışıyorsa otomatik başlayacak!`
      );
      
      if (isRunning) {
        const index = searches.length - 1;
        startPeriodicCheck(newSearch, index);
        await sendMessage('🚀 Yeni arama başlatıldı!');
      }
      
      log(`Yeni arama: ${url} (${interval} dk)`);
    });
  });
});

bot.onText(/\/liste/, async (msg) => {
  if (searches.length === 0) {
    await sendMessage('📋 Arama yok.\n\n/ekle ile ekle!');
    return;
  }
  
  for (let i = 0; i < searches.length; i++) {
    const search = searches[i];
    const isDefault = search.id === DEFAULT_SEARCH.id;
    
    const message = 
      `📍 <b>Arama ${i + 1}</b>${isDefault ? ' 🚗' : ''}\n\n` +
      `🔗 ${search.url.substring(0, 70)}...\n` +
      `⏱ Her ${search.interval} dakika`;
    
    const keyboard = {
      inline_keyboard: [[
        { text: '🗑 Sil', callback_data: `delete_${search.id}` }
      ]]
    };
    
    await sendMessage(message, { reply_markup: keyboard });
    await new Promise(r => setTimeout(r, 500));
  }
});

bot.on('callback_query', async (query) => {
  const data = query.data;
  
  if (data.startsWith('delete_')) {
    const searchId = parseInt(data.replace('delete_', ''));
    const index = searches.findIndex(s => s.id === searchId);
    
    if (index === -1) {
      await bot.answerCallbackQuery(query.id, { text: '❌ Bulunamadı!' });
      return;
    }
    
    if (intervals.has(index)) {
      clearInterval(intervals.get(index));
      intervals.delete(index);
    }
    
    const deleted = searches.splice(index, 1)[0];
    seenListings.delete(deleted.url);
    
    await bot.editMessageText(
      `✅ <b>Silindi!</b>`,
      {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        parse_mode: 'HTML'
      }
    );
    
    await bot.answerCallbackQuery(query.id, { text: '✅ Silindi!' });
    
    if (isRunning && searches.length > 0) {
      startAllChecks();
    } else if (searches.length === 0) {
      isRunning = false;
      await sendMessage('⚠️ Tüm aramalar silindi.');
    }
  }
});

bot.onText(/\/yenile/, async (msg) => {
  if (searches.length === 0) {
    await sendMessage('❌ Arama yok!');
    return;
  }
  
  await sendMessage('🔄 Kontrol ediliyor...');
  
  for (let i = 0; i < searches.length; i++) {
    await checkNewListings(searches[i], true);
    await new Promise(r => setTimeout(r, 3000));
  }
  
  await sendMessage('✅ Kontrol tamamlandı!');
});

bot.onText(/\/basla/, async (msg) => {
  if (searches.length === 0) {
    await sendMessage('❌ Önce /ekle ile arama ekle!');
    return;
  }
  
  if (isRunning) {
    await sendMessage('ℹ️ Zaten çalışıyor!');
    return;
  }
  
  if (startAllChecks()) {
    await sendMessage(
      `🚀 <b>Bot Başlatıldı!</b>\n\n` +
      `📊 ${searches.length} arama aktif\n` +
      `🔐 Proxy koruması aktif`
    );
  }
});

bot.onText(/\/durdur/, async (msg) => {
  if (!isRunning) {
    await sendMessage('ℹ️ Zaten durmuş.');
    return;
  }
  
  stopAllChecks();
  await sendMessage('⏸ Durduruldu.');
});

bot.onText(/\/durum/, async (msg) => {
  const statusMsg = 
    `📊 <b>Bot Durumu</b>\n\n` +
    `🤖 ${isRunning ? '✅ Çalışıyor' : '⏸ Durmuş'}\n` +
    `📋 Arama: ${searches.length}\n` +
    `🔐 Proxy: ${FREE_PROXIES[currentProxyIndex]}\n` +
    `🕐 Uptime: ${Math.floor(process.uptime() / 60)} dk\n` +
    `💾 RAM: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`;
  
  await sendMessage(statusMsg);
});

function initializeBot() {
  log('🚀 Bot başlatılıyor...');
  
  if (startAllChecks()) {
    sendMessage(
      `🤖 <b>Bot Başlatıldı!</b>\n\n` +
      `🚗 Otomobil ilanları aktif\n` +
      `🔐 Proxy koruması aktif\n\n` +
      `/start ile komutları gör!`
    );
  }
}

process.on('unhandledRejection', (error) => {
  log(`Hata: ${error.message}`);
});

bot.on('polling_error', (error) => {
  log(`Polling: ${error.message}`);
});