# Production frontend image: build the SPA and serve it with vite preview.
FROM node:22-alpine

WORKDIR /workspace

COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci

COPY apps apps
COPY frontend frontend

RUN npm run build --workspace @personal-platform/frontend && npm prune --omit=dev

USER node
EXPOSE 5173
CMD ["npm", "run", "preview", "--workspace", "@personal-platform/frontend", "--", "--host", "0.0.0.0", "--port", "5173"]
