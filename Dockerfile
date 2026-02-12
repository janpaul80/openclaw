FROM node:20-alpine

WORKDIR /app

# Install OpenSSH client for VPS sandbox access
RUN apk add --no-cache openssh-client

# Copy package files and install production deps
COPY package.json package-lock.json ./
RUN npm install --production

# Copy application code
COPY index.js orchestrator.js sandboxManager.js autonomousLoop.js logger.js metrics.js ./

# Set environment
ENV NODE_ENV=production
ENV PORT=3000

# Expose the port
EXPOSE 3000

# Run directly with node (not npm) for proper signal handling
CMD ["node", "index.js"]
