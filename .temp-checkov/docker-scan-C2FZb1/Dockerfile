FROM node:18-alpine AS build

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json first to leverage Docker cache
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy the rest of the application code
COPY . .

# Declare build argument for database connection
ARG DB_CONNECTION

# Expose port 443 for HTTPS traffic
EXPOSE 443

# Health check to ensure the app is running
HEALTHCHECK CMD curl --fail http://localhost:443/ || exit 1

# Run as non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

# Start the application
CMD ["npm", "start"]