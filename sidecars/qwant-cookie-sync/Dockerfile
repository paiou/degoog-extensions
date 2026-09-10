FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Install Chromium, Xvfb virtual display, full font families, Mesa OpenGL/Vulkan, and runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    chromium-common \
    xvfb \
    x11-utils \
    fonts-liberation \
    fonts-dejavu-core \
    fonts-noto-core \
    fonts-freefont-ttf \
    libgl1-mesa-dri \
    mesa-vulkan-drivers \
    libglx-mesa0 \
    libgles2-mesa \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libasound2 \
    ca-certificates \
    procps \
    curl \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV USER_DATA_DIR=/data/chromium-profile
ENV DISPLAY=:99
ENV PORT=3005

RUN mkdir -p /data/chromium-profile && chmod 777 /data/chromium-profile
VOLUME /data

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY index.mjs ./

EXPOSE 3005

# Run under Xvfb virtual display for true headful rendering
CMD ["xvfb-run", "-a", "-s", "-screen 0 1920x1080x24 -ac", "node", "index.mjs"]
