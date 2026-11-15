FROM node:24-slim

WORKDIR /app

COPY package.json server.js db.js mail.js multipart.js ./
COPY public ./public

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV DATA_DIR=/data

EXPOSE 3000

CMD ["node", "server.js"]
