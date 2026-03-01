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

# Install Python 3 + Checkov (required for Terraform, Kubernetes, and Docker security scans)
# checkov is invoked as a subprocess by the Node.js server
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates \
       python3 \
       python3-pip \
  && update-ca-certificates \
  && pip3 install --break-system-packages checkov \
  && rm -rf /var/lib/apt/lists/* /root/.cache/pip

ENV NODE_ENV=production
ENV PORT=9005

COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

EXPOSE 9005
CMD ["node", "dist/index.js"]
