FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY backend/package.json backend/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY frontend/package.json frontend/package.json
COPY frontend/oauth/package.json frontend/oauth/package.json
COPY frontend/oauth/tsconfig.json frontend/oauth/tsconfig.json
RUN npm ci
COPY frontend/oauth/src frontend/oauth/src
COPY tsconfig.base.json tsconfig.base.json
RUN npm run build --workspace=@college-library/oauth

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package*.json ./
COPY --from=build /app/backend/package.json backend/package.json
COPY --from=build /app/packages/config/package.json packages/config/package.json
COPY --from=build /app/packages/contracts/package.json packages/contracts/package.json
COPY --from=build /app/frontend/package.json frontend/package.json
COPY --from=build /app/frontend/oauth/package.json frontend/oauth/package.json
RUN npm ci --omit=dev --workspace=@college-library/oauth
COPY --from=build /app/frontend/oauth/dist frontend/oauth/dist
EXPOSE 3001
CMD ["node", "frontend/oauth/dist/server.js"]
