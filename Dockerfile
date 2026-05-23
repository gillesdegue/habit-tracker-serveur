FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY server.ts mailConfig.ts mailService.ts geminiService.ts quotesService.ts aiTypes.ts aiSettingsService.ts aiNotificationService.ts tsconfig.json ./
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist-server ./dist-server
EXPOSE 3010
CMD ["node", "dist-server/server.js"]
