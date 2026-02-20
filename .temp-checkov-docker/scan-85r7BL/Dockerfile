# ----------- Stage 1: Build Node.js dependencies and Python packages ------------
FROM node:16.20.2-alpine3.18 AS builder

# Set working directory
WORKDIR /app

# Install Python and pip for any Python dependencies
RUN apk add --no-cache python3=3.10.11-r0 py3-pip=22.3.1-r0 build-base

# Copy dependency files first for better layer caching
COPY package*.json ./
COPY requirements.txt ./

# Install Node.js dependencies (production only)
RUN npm ci --only=production

# Install Python dependencies (if requirements.txt exists)
RUN if [ -f requirements.txt ]; then pip3 install --no-cache-dir -r requirements.txt; fi

# Copy application source code
COPY . .

# Optional: Build step (uncomment if you have a build script)
# RUN npm run build

# ----------- Stage 2: Production image ------------
FROM node:16.20.2-alpine3.18

# Install Python runtime (no build tools)
RUN apk add --no-cache python3=3.10.11-r0 py3-pip=22.3.1-r0 && \
    addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy only the necessary files from builder image
COPY --from=builder /app /app

# Ensure correct ownership
RUN chown -R appuser:appgroup /app

USER appuser

EXPOSE 3000

# Healthcheck to ensure the app is running
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

# Remove pip cache and any build artifacts (if any)
RUN rm -rf /root/.cache/pip /tmp/*

# Set environment variables for security
ENV NODE_ENV=production

# Start the application
CMD [ "node", "index.js" ]
