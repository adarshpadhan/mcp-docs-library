FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY backend/package.json backend/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY frontend/package.json frontend/package.json
COPY frontend/oauth/package.json frontend/oauth/package.json
RUN npm ci
COPY frontend frontend
RUN npx tsc --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --esModuleInterop --skipLibCheck --outDir frontend/dist frontend/src/server.ts

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package*.json ./
COPY --from=build /app/backend/package.json backend/package.json
COPY --from=build /app/packages/config/package.json packages/config/package.json
COPY --from=build /app/packages/contracts/package.json packages/contracts/package.json
COPY --from=build /app/frontend/package.json frontend/package.json
COPY --from=build /app/frontend/oauth/package.json frontend/oauth/package.json
RUN npm ci --omit=dev
COPY --from=build /app/frontend/dist frontend/dist
COPY --from=build /app/frontend/public frontend/public
EXPOSE 3000
CMD ["node", "frontend/dist/server.js"]
