FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY public ./public
COPY server ./server
COPY db ./db
COPY scripts ./scripts
RUN mkdir -p /app/.data && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "server/agentbar-api.js"]
