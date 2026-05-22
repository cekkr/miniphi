FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY bot.js ./
COPY SOUL.md ./
CMD ["node", "bot.js"]
