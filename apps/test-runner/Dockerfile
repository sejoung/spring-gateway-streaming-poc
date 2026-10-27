# k6 with the xk6-sse extension, plus the Node runner that drives it.
FROM grafana/xk6:1.4.15 AS k6
RUN xk6 build v2.3.0 --with github.com/phymbert/xk6-sse@v0.2.0 --output /tmp/k6

FROM node:24-alpine
COPY --from=k6 /tmp/k6 /usr/local/bin/k6
WORKDIR /app
COPY package.json ./
COPY src src
COPY k6 k6
ENV DATA_DIR=/data/runs PORT=8070
EXPOSE 8070
CMD ["node", "src/server.mjs"]
