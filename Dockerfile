FROM node:24-slim

WORKDIR /app

# Install server deps
COPY server/package.json ./server/
RUN cd server && npm install --omit=dev

# Install client deps and build
COPY client/package.json ./client/
RUN cd client && npm install && npm run build

# Copy source
COPY server/src ./server/src

ENV NODE_ENV=production
ENV PORT=4000
EXPOSE 4000

CMD ["node", "server/src/index.js"]
