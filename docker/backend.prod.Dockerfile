FROM node:22-alpine AS build

WORKDIR /workspace

COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci

# Registry checking needs both backend and frontend sources, even though only
# the backend is compiled for this image. Host dependencies/dist are ignored.
COPY . .
RUN npm run generate:apps:check \
    && npm run build --workspace @personal-platform/backend

FROM node:22-alpine AS production-dependencies

WORKDIR /workspace

COPY backend/package.json ./package.json
COPY package-lock.json ./
# A workspace-scoped install still inherits the shared lockfile's production
# flags for frontend tooling. Derive a standalone backend view without changing
# repository files or resolving newer versions from the registry.
RUN node <<'NODE'
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
delete manifest.devDependencies;
delete manifest.scripts;
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
lock.name = manifest.name;
lock.version = manifest.version;
lock.packages[""] = { ...manifest };
for (const [path, entry] of Object.entries(lock.packages)) {
  if (path === "backend" || path === "frontend" || entry.link) delete lock.packages[path];
}
fs.writeFileSync("package.json", JSON.stringify(manifest));
fs.writeFileSync("package-lock.json", JSON.stringify(lock));
NODE
RUN npm install --package-lock-only --ignore-scripts --omit=dev --workspaces=false --offline --no-audit --no-fund \
    && npm ci --omit=dev --workspaces=false --no-audit --no-fund \
    && npm cache clean --force

FROM node:22-alpine AS runtime

WORKDIR /workspace
ENV NODE_ENV=production \
    PLATFORM_ROOT=/workspace \
    HOST=0.0.0.0 \
    PORT=8000

COPY package.json ./
COPY --from=production-dependencies /workspace/node_modules ./node_modules
COPY --from=production-dependencies /workspace/package.json ./backend/package.json
COPY --from=build /workspace/backend/dist ./backend/dist
COPY --from=build /workspace/config ./config
COPY --from=build /workspace/apps ./apps
COPY --from=build /workspace/migrations ./migrations
COPY docker/backend-entrypoint.sh /usr/local/bin/pp-backend-entrypoint

# Docker copies this ownership into a newly created app-storage volume.
RUN mkdir -p /workspace/storage \
    && chown node:node /workspace/storage \
    && chmod 0755 /usr/local/bin/pp-backend-entrypoint

USER node
EXPOSE 8000
ENTRYPOINT ["sh", "/usr/local/bin/pp-backend-entrypoint"]
CMD ["node", "backend/dist/main.js"]
