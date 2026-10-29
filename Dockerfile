FROM node:24.10.0-bookworm-slim@sha256:b8d2197aff9129d16c801a3e3e1b2a873c4946480f5a310f38056df2268c38d9 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json ./apps/server/package.json
RUN npm ci --ignore-scripts --workspace @tabularium/server --include-workspace-root
COPY apps/server/tsconfig.json ./apps/server/tsconfig.json
COPY apps/server/src ./apps/server/src
COPY apps/server/tsconfig.ui.json apps/server/build-ui.mjs ./apps/server/
COPY apps/server/ui ./apps/server/ui
RUN npm run build:server

FROM node:24.10.0-bookworm-slim@sha256:b8d2197aff9129d16c801a3e3e1b2a873c4946480f5a310f38056df2268c38d9
WORKDIR /app
COPY --from=build /app/apps/server/dist ./dist
COPY apps/server/package.json ./package.json
ENV HOST=0.0.0.0 PORT=3000 TABULARIUM_DATABASE=/data/tabularium.sqlite
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
