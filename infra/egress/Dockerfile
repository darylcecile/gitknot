FROM node:24.20.0-trixie-slim@sha256:a747ad80c8a161b650d79a6da9c422005b91148b18b8d2c669eb5a0b7c07e600
WORKDIR /app
# The transport uses only Node APIs and the already-locked zod dependency of
# core's bounded request reader. No package manager or credentials run here.
COPY node_modules/zod ./node_modules/zod
COPY packages/core ./packages/core
COPY packages/operations/src/security.ts ./packages/operations/src/security.ts
COPY ops/egress ./ops/egress
USER node
EXPOSE 8080
CMD ["node", "ops/egress/server.ts"]
