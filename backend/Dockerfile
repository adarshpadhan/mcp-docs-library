FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package*.json ./
COPY backend/package.json backend/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY local-ingest/package.json local-ingest/package.json
RUN npm ci

COPY tsconfig.base.json tsconfig.json ./
COPY packages/config packages/config
COPY packages/contracts packages/contracts
COPY local-ingest local-ingest
COPY backend backend
RUN npm run build -- --force

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package*.json ./
COPY --from=build /app/backend/package.json backend/package.json
COPY --from=build /app/packages/config/package.json packages/config/package.json
COPY --from=build /app/packages/contracts/package.json packages/contracts/package.json
COPY --from=build /app/local-ingest/package.json local-ingest/package.json
RUN npm ci --omit=dev
COPY --from=build /app/backend/dist backend/dist
COPY --from=build /app/packages/config/dist packages/config/dist
COPY --from=build /app/packages/contracts/dist packages/contracts/dist

EXPOSE 8787
CMD ["node", "backend/dist/server.js"]
