# Wikinest — web + MCP server image.
# Only runtime deps are installed (electron / electron-builder are devDependencies
# and skipped via --omit=dev), keeping the image small.
FROM node:20-alpine

WORKDIR /app

# Install production dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source (see .dockerignore for what's excluded).
COPY . .

ENV NODE_ENV=production
ENV WIKI_PORT=4321
# Notes live here; docker-compose mounts a host volume over it for persistence.
ENV WIKI_CONTENT_DIR=/app/content

EXPOSE 4321

CMD ["node", "bin/wiki.js", "serve"]
