FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.mjs ./
RUN mkdir -p public
COPY workspace.html workspace.js ./public/
ENV PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
