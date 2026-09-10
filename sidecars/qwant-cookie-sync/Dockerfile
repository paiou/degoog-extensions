FROM node:24-alpine

# Install Chromium and system dependencies for Puppeteer
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY index.mjs ./

ENV PORT=3005

EXPOSE 3005

CMD ["node", "index.mjs"]
