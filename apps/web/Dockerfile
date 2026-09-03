FROM node:22-alpine
WORKDIR /app
ARG NEXT_PUBLIC_API_URL=http://localhost:3001
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
COPY apps/web/package*.json ./apps/web/
RUN cd apps/web && npm ci
COPY apps/web ./apps/web
RUN cd apps/web && npm run build
EXPOSE 3000
CMD ["npm", "--prefix", "apps/web", "start"]
