FROM node:22-alpine

WORKDIR /workspace

COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci

COPY frontend frontend

EXPOSE 5173
CMD ["npm", "run", "dev", "--workspace", "@personal-platform/frontend"]
