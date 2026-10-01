FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY lib ./lib
COPY worker ./worker
CMD ["node", "--experimental-strip-types", "worker/index.ts"]
