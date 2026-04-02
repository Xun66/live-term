# Use lightweight Node image
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Initialize a clean package and install only the relay server dependency
# This avoids issues with node-pty which requires build tools not present in alpine
RUN npm init -y && npm install ws --silent

# Copy server code
COPY server/ ./server/

# Expose relay port
EXPOSE 8080

# Set default port environment variable
ENV PORT=8080

# Start relay server
CMD ["node", "server/index.js"]
