# syntax=docker/dockerfile:1
#
# EspoMCP (cauldr0nx/EspoMCP) con trasporto Streamable HTTP
# - clona l'upstream a un commit fissato (riproducibile)
# - aggiunge src/http.ts (entrypoint HTTP)
# - compila TypeScript e produce un'immagine runtime minimale non-root

ARG NODE_VERSION=20-alpine

# ---------- build ----------
FROM node:${NODE_VERSION} AS build
ARG ESPOMCP_REPO=https://github.com/cauldr0nx/EspoMCP.git
ARG ESPOMCP_REF=8e180099e6798ac81b9826e9408fc41cb4fac37d

RUN apk add --no-cache git
WORKDIR /src
RUN git clone "${ESPOMCP_REPO}" repo \
 && cd repo \
 && git checkout "${ESPOMCP_REF}"

WORKDIR /src/repo/EspoMCP
COPY src/http.ts ./src/http.ts

RUN npm ci --no-audit --no-fund \
 && npx tsc \
 && npm prune --omit=dev \
 && npm cache clean --force

# ---------- runtime ----------
FROM node:${NODE_VERSION}
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    MCP_PATH=/mcp \
    LOG_LEVEL=info

COPY --from=build --chown=node:node /src/repo/EspoMCP/package*.json ./
COPY --from=build --chown=node:node /src/repo/EspoMCP/node_modules ./node_modules
COPY --from=build --chown=node:node /src/repo/EspoMCP/build ./build
RUN mkdir -p /app/logs && chown node:node /app/logs

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "build/http.js"]
