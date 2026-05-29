FROM node:22-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js db.js auth.js ./

ENV NODE_ENV=production
ENV DATA_DIR=/data
RUN mkdir -p /data

EXPOSE 8787

CMD ["node", "server.js"]
