FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages ./packages
COPY apps ./apps
COPY db ./db
COPY scripts ./scripts
COPY test-vectors ./test-vectors
COPY tsconfig.json ./
RUN npm ci --legacy-peer-deps --omit=dev && npm i -g tsx
# One service runs all three watchers from the secret WATCHTOWER_BUNDLE (see docs/RUNBOOK.md, "Running in the cloud").
# docker-compose.yml overrides this to run one watcher per container.
CMD ["tsx", "scripts/cloud.ts"]
