FROM node:20-slim

WORKDIR /app

# Install build dependencies for native modules (sqlite3)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./

# Install npm packages
RUN npm install

# Copy application source
COPY . .

# Expose Hugging Face default port
EXPOSE 7860
ENV PORT=7860

CMD ["node", "src/server.js"]
