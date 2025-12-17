const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');

// Ücretsiz proxy kaynakları
const PROXY_SOURCES = [
    'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=5000&country=all&ssl=yes&anonymity=all',
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
    'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt'
];

const TARGET_URL = 'https://www.sahibinden.com/favicon.ico';
const TIMEOUT = 5000; // 5 saniye timeout

console.log('🔍 Ücretsiz ve çalışan proxy\'ler aranıyor...');
console.log('⚠️  NOT: Ücretsiz proxy\'ler yavaştır ve çabuk kapanır.');
console.log('--------------------------------------------------');

async function fetchProxies(url) {
    return new Promise((resolve) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                // IP:PORT formatındaki satırları bul
                const proxies = data.match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+/g) || [];
                resolve(proxies);
            });
        }).on('error', () => resolve([]));
    });
}

async function checkProxy(proxyUrl) {
    return new Promise((resolve) => {
        const agent = new HttpsProxyAgent(`http://${proxyUrl}`);
        const options = {
            agent,
            timeout: TIMEOUT,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        };

        const start = Date.now();
        const req = https.get(TARGET_URL, options, (res) => {
            if (res.statusCode === 200) {
                const time = Date.now() - start;
                resolve({ url: `http://${proxyUrl}`, time });
            } else {
                resolve(null);
            }
        });

        req.on('error', () => resolve(null));
        req.on('timeout', () => {
            req.destroy();
            resolve(null);
        });
    });
}

async function main() {
    // 1. Proxy listelerini çek
    let allProxies = new Set();

    for (const source of PROXY_SOURCES) {
        console.log(`📥 Liste indiriliyor: ${source.substring(0, 40)}...`);
        const proxies = await fetchProxies(source);
        proxies.forEach(p => allProxies.add(p));
    }

    const uniqueProxies = Array.from(allProxies);
    console.log(`\n📋 Toplam ${uniqueProxies.length} adet aday proxy bulundu.`);
    console.log(`🚀 Test başlıyor (Bu işlem biraz sürebilir)...\n`);

    // 2. Proxy'leri test et (Paralel olarak, 20'şerli gruplar halinde)
    const workingProxies = [];
    const BATCH_SIZE = 50;

    for (let i = 0; i < uniqueProxies.length; i += BATCH_SIZE) {
        const batch = uniqueProxies.slice(i, i + BATCH_SIZE);
        const promises = batch.map(p => checkProxy(p));
        const results = await Promise.all(promises);

        results.forEach(res => {
            if (res) {
                console.log(`✅ ÇALIŞIYOR: ${res.url} (${res.time}ms)`);
                workingProxies.push(res.url);
            }
        });

        // Yeterli sayıda bulduysak duralım (Örn: 5 tane yeter)
        if (workingProxies.length >= 5) {
            break;
        }

        process.stdout.write(`⏳ İlerleme: ${Math.min(i + BATCH_SIZE, uniqueProxies.length)}/${uniqueProxies.length}\r`);
    }

    // 3. Sonucu yazdır
    console.log('\n\n✨ SONUÇLAR ✨');
    if (workingProxies.length > 0) {
        console.log('Aşağıdaki satırı kopyalayıp PROXIES ayarına yapıştırın:');
        console.log('\nPROXIES=' + workingProxies.join(','));
    } else {
        console.log('❌ Maalesef çalışan proxy bulunamadı. Lütfen daha sonra tekrar deneyin.');
    }
}

main();
