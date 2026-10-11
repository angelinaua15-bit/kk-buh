FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p /data
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
