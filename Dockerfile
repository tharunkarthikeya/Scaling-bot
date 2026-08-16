# syntax=docker/dockerfile:1

# ---- build ----------------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

# mongodb-memory-server is a devDependency used only by the local harness. Its
# postinstall downloads a ~74MB mongod binary, which is dead weight in the image
# and fails outright on musl. The build needs its types, not its binary.
ENV MONGOMS_DISABLE_POSTINSTALL=1

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies so they aren't carried into the runtime image.
RUN npm prune --omit=dev

# ---- runtime --------------------------------------------------------------
FROM node:22-alpine AS runtime

ENV NODE_ENV=production

# The app's own default is 3100, but the image exposes 3000 and Dokploy maps the
# domain to 3000. Without this default the container listens on a port nothing
# is routed to, and the deploy looks healthy while being unreachable.
ENV PORT=3000

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# Candidate documents are PII. Run unprivileged, and keep storage on a mount
# so a redeploy doesn't destroy files that have not been reviewed yet.
RUN mkdir -p /data/storage && chown -R node:node /data
VOLUME ["/data/storage"]
ENV STORAGE_PATH=/data/storage

USER node

EXPOSE 3000

# The app has no /health dependency on Mongo being warm, so this is a genuine
# liveness signal rather than a readiness one.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
