# Multi-stage Dockerfile for QueueFlow
# Stage 1: Build
FROM node:18-alpine AS builder

WORKDIR /app

# Set npm configurations for better reliability
ENV NPM_CONFIG_LOGLEVEL=warn
ENV NPM_CONFIG_PROGRESS=false

# Copy package files
COPY package.json package-lock.json* ./
COPY tsconfig.json ./

# Install all dependencies (production + dev for building)
RUN npm config set fetch-timeout 600000 && \
    npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000 && \
    npm install --legacy-peer-deps

# Copy source code
COPY src ./src

# Build TypeScript
RUN npm run build

# Stage 2: Production
FROM node:18-alpine

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create app user
RUN addgroup -g 1001 -S queueflow && \
    adduser -S -u 1001 -G queueflow queueflow

WORKDIR /app

# Set npm configurations
ENV NPM_CONFIG_LOGLEVEL=warn
ENV NPM_CONFIG_PROGRESS=false
ENV NODE_ENV=production

# Copy package files
COPY package.json package-lock.json* ./

# Install only production dependencies
RUN npm config set fetch-timeout 600000 && \
    npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000 && \
    npm install --production --legacy-peer-deps && \
    npm cache clean --force

# Copy built application from builder
COPY --from=builder /app/dist ./dist

# Create logs directory
RUN mkdir -p logs && \
    chown -R queueflow:queueflow /app

# Switch to non-root user
USER queueflow

# Expose ports
EXPOSE 3000 9090

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health/liveness', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})" || exit 1

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start application
CMD ["node", "dist/index.js"]
