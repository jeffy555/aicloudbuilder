FROM node:18-alpine AS builder

# Set the working directory
WORKDIR /app

# Copy package.json and package-lock.json first to leverage caching
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy the rest of the application code
COPY . .

# Build the application (if applicable, e.g., for TypeScript)
# RUN npm run build

# Create a new stage for the final image
FROM node:18-alpine AS production

# Set the working directory
WORKDIR /app

# Copy only the necessary files from the builder stage
COPY --from=builder /app .

# Create a non-root user and switch to it
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

# Declare build argument for database connection string
ARG DATABASE_URL

# Set environment variable for the database connection string
ENV DATABASE_URL=${DATABASE_URL}

# Expose port 443 for HTTPS traffic
EXPOSE 443

# Health check to ensure the app is running
HEALTHCHECK --interval=30s --timeout=10s --retries=3 CMD curl -f http://localhost:443/ || exit 1

# Start the application
CMD [ "node", "server.js" ]