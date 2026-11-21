FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.mjs bridge.mjs oauth.mjs photopea.mjs pdf.mjs workspace.html workspace.js ./
USER node
ENV PORT=3000 STORAGE_DIR=/tmp/photopea-exports
EXPOSE 3000
CMD ["node", "server.mjs"]
