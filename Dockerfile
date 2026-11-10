FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages ./packages
COPY apps ./apps
COPY db ./db
COPY scripts ./scripts
COPY test-vectors ./test-vectors
RUN npm ci --legacy-peer-deps --omit=dev && npm i -g tsx
ENTRYPOINT ["tsx", "packages/watcher/src/cli.ts"]
CMD ["run", "--config", "/config/watchtower.config.json"]
