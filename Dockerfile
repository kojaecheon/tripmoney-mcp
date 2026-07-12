FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 8000
CMD ["npm", "run", "start:kakao"]
