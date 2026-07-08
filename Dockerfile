FROM node:22-slim AS deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV KADERA_BACKEND_URL=https://kadera-malgo-production.up.railway.app
ENV BACKEND_TIMEOUT_MS=60000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

EXPOSE 3000
CMD ["node", "dist/server.js"]
