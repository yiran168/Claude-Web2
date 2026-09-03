FROM node:24-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.server.json tsconfig.web.json vite.config.ts vitest.config.ts ./
COPY src ./src
COPY web ./web
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine AS runtime

ENV NODE_ENV=production \
    CW2_RUNTIME=container \
    CW2_HOST=0.0.0.0 \
    CW2_PORT=8787 \
    CW2_DATA_DIR=/app/data

WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/scripts ./scripts

RUN mkdir -p /app/data && chown node:node /app/data
USER node

EXPOSE 8787
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/server/index.js"]
