FROM node:20-alpine AS client-build

WORKDIR /app/client

COPY web/client/package.json web/client/package-lock.json ./
RUN npm ci

COPY web/client .
RUN npm run build

FROM node:20-alpine

WORKDIR /app

COPY web/server/package.json web/server/package-lock.json ./
RUN npm ci --omit=dev

COPY web/server .
COPY --from=client-build /app/client/dist /app/public

ENV NODE_ENV=production
ENV PORT=80

EXPOSE 80

CMD ["node", "src/index.js"]
