FROM node:22.22.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/console/package.json ./apps/console/package.json
COPY apps/keycloak-theme/package.json ./apps/keycloak-theme/package.json
COPY packages ./packages
RUN npm ci --ignore-scripts
COPY tsconfig*.json ./
COPY scripts/build-packages.mjs ./scripts/build-packages.mjs
COPY scripts/packaging/release-metadata.mjs scripts/packaging/release-metadata.json scripts/packaging/build-receipt.mjs ./scripts/packaging/
# Release metadata checks the wheel version against the JavaScript packages.
COPY python/pyproject.toml ./python/pyproject.toml
COPY apps/console ./apps/console
RUN npm run build:packages && npm run build:console
# Nitro emits a standalone server tree, including its traced runtime dependencies.

FROM node:22.22.0-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3100
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/console/.output ./.output
COPY --chown=node:node deploy/console-probe.mjs ./deploy/console-probe.mjs
USER node
EXPOSE 3100
CMD ["node", ".output/server/index.mjs"]
