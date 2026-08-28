FROM node:22-alpine

WORKDIR /workspace

COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci

COPY backend backend

EXPOSE 8000
CMD ["npm", "run", "dev", "--workspace", "@personal-platform/backend"]
