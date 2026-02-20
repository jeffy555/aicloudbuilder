# ----------- Stage 1: Build Dependencies & App -----------
FROM node:16.20.2-alpine3.18 AS builder

# Set working directory
WORKDIR /app

# Install build dependencies for native modules (if needed)
RUN apk add --no-cache --virtual .gyp python3 make g++

# Copy package.json and package-lock.json for better caching
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production

# Copy the rest of the application code
COPY . .

# Remove build dependencies to reduce size
RUN apk del .gyp

# ----------- Stage 2: Python Dependencies (if needed) -----------
# If your app needs Python dependencies, add here. Example:
# FROM python:3.11.8-alpine3.18 AS pydeps
# WORKDIR /pydeps
# COPY requirements.txt ./
# RUN pip install --user --no-cache-dir -r requirements.txt

# ----------- Stage 3: Final Minimal Image -----------
FROM node:16.20.2-alpine3.18

# Install runtime dependencies for node and python (if needed)
RUN apk add --no-cache curl

# Create non-root user and group
RUN addgroup -g 10001 -S appgroup \
    && adduser -u 10001 -S appuser -G appgroup

WORKDIR /app

# Copy app from builder stage
COPY --from=builder /app .

# If Python dependencies are needed, uncomment below:
# COPY --from=pydeps /root/.local /root/.local
# ENV PATH="/root/.local/bin:$PATH"

# Set ownership and permissions
RUN chown -R appuser:appgroup /app

USER appuser

EXPOSE 3000

# Healthcheck to ensure the app is running
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

# Use NODE_ENV=production for security and performance
ENV NODE_ENV=production

# Start the application
CMD ["node", "index.js"]
