# Build the browser editor before pruning development dependencies.
FROM node:20-alpine AS editor-build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci
COPY vite.editor.config.ts tsconfig.editor.json ./
COPY web-editor ./web-editor
RUN npm run editor:build

# Wikinest — web + MCP runtime image.
FROM node:20-alpine

WORKDIR /app

# Install production dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source (see .dockerignore for what's excluded).
COPY . .
COPY --from=editor-build /app/web-dist ./web-dist

ENV NODE_ENV=production
ENV WIKI_PORT=4321
# Notes live here; docker-compose mounts a host volume over it for persistence.
ENV WIKI_CONTENT_DIR=/app/content

EXPOSE 4321

CMD ["node", "bin/wiki.js", "serve"]
