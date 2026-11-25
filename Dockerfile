FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
  git \
  ca-certificates \
  curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npm install tsx

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/v1/health || exit 1

CMD ["npx", "tsx", "server.ts"]
