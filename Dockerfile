FROM oven/bun:1.4.3 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.4.3 AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3001
ENV DATA_FILE=/data/rooms.json
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production && mkdir -p /data && chown bun:bun /data
COPY --from=build --chown=bun:bun /app/dist ./dist
COPY --chown=bun:bun server.mjs ./server.mjs
USER bun
VOLUME ["/data"]
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3001) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["bun", "server.mjs"]
