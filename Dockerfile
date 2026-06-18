FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    ca-certificates \
    curl \
    unzip \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir --break-system-packages -U yt-dlp

# Install Deno for yt-dlp YouTube signature / n-challenge solving
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh

ENV PATH="/usr/local/bin:/root/.deno/bin:${PATH}"

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3000

CMD ["npm", "start"]