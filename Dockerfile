# LearnHarness web + accounts gateway (mobile/accounts wave, 2026-10-31).
#
#   docker build -t learnharness-web .
#   docker run -p 8080:8080 -v lh-data:/var/lib/learnharness learnharness-web
#
# One container runs the gateway (gateway/server.mjs), which starts one
# LearnHarness process per signed-in user inside the same container. Put a
# TLS terminator in front (docker-compose.yml ships Caddy) — the PWA needs
# https. All mutable state lives under /var/lib/learnharness.

# ---------------------------------------------------------------- build stage
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PUPPETEER_SKIP_DOWNLOAD=1 \
    NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Dependencies move aside so the runtime stage can layer them separately:
# an app-only change then re-ships ~100MB, not the whole ~1GB tree.
RUN npm run build && npm prune --omit=dev --no-audit --no-fund && mv node_modules /deps

# -------------------------------------------------------------- runtime stage
FROM node:22-bookworm-slim
# Chromium is the demo-builder's verification browser (puppeteer-core via
# CHROME_PATH); fonts cover PDF/SVG rendering. Drop this block to shave
# ~350MB if demos are not needed.
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-core fonts-noto-color-emoji ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    CHROME_PATH=/usr/bin/chromium \
    LH_HOME=/var/lib/learnharness \
    GATEWAY_PORT=8080 \
    GATEWAY_HOST=0.0.0.0 \
    LH_IDLE_MINUTES=60
WORKDIR /app
COPY --from=build --chown=node:node /deps /app/node_modules
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /var/lib/learnharness && chown node:node /var/lib/learnharness
USER node
VOLUME ["/var/lib/learnharness"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:8080/gateway/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "gateway/server.mjs"]
