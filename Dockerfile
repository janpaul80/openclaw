FROM node:20-alpine

WORKDIR /app

# Copy package files and install production deps
COPY package.json ./
RUN npm install --production

# Copy application code
COPY index.js ./

# Set environment
ENV NODE_ENV=production
ENV PORT=3000

# Expose the port
EXPOSE 3000

# Run directly with node (not npm) for proper signal handling
CMD ["node", "index.js"]
