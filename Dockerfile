FROM oven/bun:1.4.4
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY scripts ./scripts
COPY config ./config
COPY docs ./docs
COPY indicators ./indicators
RUN mkdir -p /app/data && chown -R bun:bun /app/data
USER bun
ENV NODE_ENV=production MODE=paper MODEL=mock HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data
EXPOSE 3000
VOLUME ["/app/data"]
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s CMD bun -e 'const r=await fetch("http://127.0.0.1:3000/healthz"); if(!r.ok)process.exit(1)'
CMD ["bun", "run", "src/index.ts"]
