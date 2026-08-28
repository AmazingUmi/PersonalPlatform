# Production backend image: install dev toolchain, build, prune, run dist.
FROM node:22-alpine

WORKDIR /workspace

COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci

COPY apps apps
COPY config config
COPY migrations migrations
COPY scripts scripts
COPY backend backend

RUN npm run build --workspace @personal-platform/backend && npm prune --omit=dev

ENV NODE_ENV=production
USER node
EXPOSE 8000
CMD ["node", "dist/main.js"]
