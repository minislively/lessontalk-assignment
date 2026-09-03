FROM node:22-alpine
WORKDIR /app
COPY apps/api/package*.json ./apps/api/
COPY prisma ./prisma
RUN cd apps/api && npm ci
COPY apps/api ./apps/api
RUN cd apps/api && npm run build
EXPOSE 3001
CMD ["sh", "-c", "sleep 5; npm --prefix apps/api start"]
