const { chromium } = require('playwright');
const TelegramBot = require('node-telegram-bot-api');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || 'BURAYA_TOKEN';
const CHAT_ID = process.env.CHAT_ID || 'BURAYA_CHAT_ID';
const bot = new TelegramBot(TELEGRAM_TOKEN);

const SEARCHES = [
  {
    url: 'https://www.sahibinden.com/kiralik-daire/istanbul',
    interval: 5
  }
];

const seenListings = new Map();

function log(message) {
  console.log(`[${new Date().toLocaleString('tr-TR')}] ${message}`);
}

async function sendTelegram(text) {
  try {
    await bot.sendMessage(CHAT_ID, text, { parse_mode: 'HTML' });
    log('Telegram mesajı gönderildi');
  } catch (error) {
    log(`Telegram hatası: ${error.message}`);
  }
}

async function fetchListings(searchUrl) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'tr-TR'
    });

    const page = await context.newPage();
    log(`URL açılıyor: ${searchUrl}`);
    
    await page.goto(searchUrl, { 
      waitUntil: 'networkidle',
      timeout: 60000 
    });

    await page.waitForTimeout(2000 + Math.random() * 3000);

    const listings = await page.evaluate(() => {
      const items = [];
      const rows = document.querySelectorAll('tr.searchResultsItem');
      
      rows.forEach(row => {
        const link = row.querySelector('a[href*="/ilan/"]');
        if (!link) return;
        
        const url = link.href;
        const id = url.match(/\/(\d+)$/)?.[1];
        if (!id) return;

        const title = row.querySelector('.classifiedTitle')?.textContent?.trim();
        const price = row.querySelector('.searchResultsPriceValue')?.textContent?.trim();
        const location = row.querySelector('.searchResultsLocationValue')?.textContent?.trim();
        const date = row.querySelector('.searchResultsDateValue span')?.getAttribute('title');

        items.push({ id, title, price, location, date, url });
      });

      return items;
    });

    await browser.close();
    log(`${listings.length} ilan bulundu`);
    return listings;

  } catch (error) {
    await browser.close();
    log(`Hata: ${error.message}`);
    return [];
  }
}

async function checkNewListings(search) {
  try {
    const listings = await fetchListings(search.url);
    
    if (listings.length === 0) {
      log('İlan bulunamadı');
      return;
    }

    const searchKey = search.url;
    
    if (!seenListings.has(searchKey)) {
      seenListings.set(searchKey, new Set(listings.map(l => l.id)));
      log(`${listings.length} ilan ilk defa kaydedildi`);
      await sendTelegram(`✅ Bot başlatıldı!\n${listings.length} mevcut ilan bulundu.`);
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
        
        await sendTelegram(message);
        seen.add(listing.id);
        await new Promise(r => setTimeout(r, 2000));
      }
    } else {
      log('Yeni ilan yok');
    }

  } catch (error) {
    log(`Kontrol hatası: ${error.message}`);
  }
}

async function startBot() {
  log('🚀 Bot başlatılıyor...');
  await sendTelegram('🤖 Sahibinden.com bot başlatıldı!');

  SEARCHES.forEach((search, index) => {
    log(`Arama ${index + 1} başlatıldı: ${search.url}`);
    checkNewListings(search);
    
    setInterval(() => {
      log(`--- Kontrol ${index + 1} başlıyor ---`);
      checkNewListings(search);
    }, search.interval * 60 * 1000);
  });
}

process.on('unhandledRejection', (error) => {
  log(`Hata: ${error.message}`);
});

startBot();
