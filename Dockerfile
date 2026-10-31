FROM node:24.10.0-bookworm-slim@sha256:b8d2197aff9129d16c801a3e3e1b2a873c4946480f5a310f38056df2268c38d9 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json ./apps/server/package.json
RUN npm ci --ignore-scripts --workspace @tabularium/server --include-workspace-root
COPY apps/server/tsconfig.json ./apps/server/tsconfig.json
COPY apps/server/src ./apps/server/src
COPY apps/server/tsconfig.ui.json apps/server/build-ui.mjs ./apps/server/
COPY apps/server/ui ./apps/server/ui
# The web notes page is built on the host (npm run build:notes), it needs the plug-in's dependencies.
COPY apps/server/notes-dist ./apps/server/notes-dist
RUN npm run build --workspace @tabularium/server
# Runtime packages only: the provider SDKs and the passphrase check for Tabularius. pdf.js only reads the text of PDF
# attachments; its optional canvas package (for drawing pages as pictures) is not used and is left out.
RUN rm -rf node_modules && npm ci --ignore-scripts --omit=dev --workspace @tabularium/server --include-workspace-root \
    && rm -rf node_modules/@napi-rs

FROM node:24.10.0-bookworm-slim@sha256:b8d2197aff9129d16c801a3e3e1b2a873c4946480f5a310f38056df2268c38d9
WORKDIR /app
COPY --from=build /app/apps/server/dist ./dist
COPY --from=build /app/node_modules ./node_modules
# Tabularius's hosted clients: the upstream CLI bundle with its packages, collected on the host (npm run build:cli).
COPY apps/server/cli-dist ./cli
COPY apps/server/package.json ./package.json
ENV HOST=0.0.0.0 PORT=3000 TABULARIUM_DATABASE=/data/tabularium.sqlite
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
