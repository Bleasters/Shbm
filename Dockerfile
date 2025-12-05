FROM node:18-bullseye

# Sistem paketlerini güncelle
RUN apt-get update && apt-get install -y \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    libatspi2.0-0 \
    libxshmfence1 \
    fonts-liberation \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Package.json kopyala ve yükle
COPY package*.json ./
RUN npm install

# Playwright kur
RUN npx playwright install chromium
RUN npx playwright install-deps

# Kodları kopyala
COPY . .

# Portu aç (Railway için)
EXPOSE 3000

# Başlat
CMD ["npm", "start"]