FROM node:20-bookworm-slim AS deps
WORKDIR /app

COPY package*.json ./
RUN npm ci

FROM deps AS build
WORKDIR /app

COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:20-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=9005

COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

EXPOSE 9005
CMD ["node", "dist/index.js"]
