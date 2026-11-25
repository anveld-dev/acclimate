FROM node:22.22.0-bookworm-slim AS theme
RUN apt-get update && apt-get install -y --no-install-recommends maven openjdk-17-jdk-headless ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/console/package.json ./apps/console/package.json
COPY apps/keycloak-theme ./apps/keycloak-theme
COPY apps/console/src/theme ./apps/console/src/theme
COPY packages ./packages
RUN npm ci --ignore-scripts && npm run build:theme

FROM quay.io/keycloak/keycloak:26.8.2 AS build
ENV KC_DB=postgres KC_HEALTH_ENABLED=true KC_METRICS_ENABLED=true
COPY --from=theme --chown=1000:0 /app/apps/keycloak-theme/dist_keycloak/acclimate-keycloak-theme.jar /opt/keycloak/providers/acclimate-keycloak-theme.jar
# Stable timestamps keep optimized startup valid across Docker build stages.
RUN touch -m --date=@1743465600 /opt/keycloak/providers/acclimate-keycloak-theme.jar
RUN /opt/keycloak/bin/kc.sh build

FROM quay.io/keycloak/keycloak:26.8.2
COPY --from=build /opt/keycloak/ /opt/keycloak/
COPY --chown=1000:0 deploy/keycloak/health.sh /opt/keycloak/bin/acclimate-health.sh
ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
