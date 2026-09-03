FROM node:22-alpine
WORKDIR /app
COPY index.mjs ./
COPY config ./config
COPY specs ./specs
EXPOSE 8800 8801 8802 8803 8804
# 지원자가 depends_on 의 service_healthy 로 기동 순서를 잡을 수 있게 한다.
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8800/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "index.mjs"]
