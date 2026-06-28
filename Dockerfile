FROM node:26-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src/ ./src/
COPY services/ ./services/
COPY workflows/ ./workflows/
COPY utils/ ./utils/
EXPOSE 8080
CMD ["node", "src/index.js"]
