# Build from the repo root: docker build -f backend/Dockerfile .
# (root context is required because the image needs the migrations/ directory)

# ---- build stage ----
FROM node:22-alpine AS build
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/tsconfig.json backend/nest-cli.json ./
COPY backend/src ./src
RUN npm run build

# ---- runtime stage ----
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/backend/dist ./dist
# migrate.js resolves migrations relative to dist/database as ../../../migrations = /app/migrations
COPY migrations /app/migrations
EXPOSE 3000
# Run migrations first, then start the server
CMD ["sh", "-c", "node dist/database/migrate.js && node dist/main.js"]
