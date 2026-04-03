# Stage 1: Build/Install
FROM node:20-alpine AS builder

WORKDIR /app

# Install only the production dependency
RUN npm init -y && npm install ws --production --silent

# Stage 2: Runtime
# We use alpine again but copy only what's needed to keep it tiny
FROM node:20-alpine

WORKDIR /app

# Copy node_modules and server code from builder
COPY --from=builder /app/node_modules ./node_modules
COPY server/ ./server/

# Expose relay port
EXPOSE 8080
ENV PORT=8080

# Start relay server
CMD ["node", "server/index.js"]
