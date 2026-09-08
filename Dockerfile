# A.S.S. Score production image — Node 20 on Alpine
FROM node:20-alpine

# better-sqlite3 has no musl prebuilds, so we need a C toolchain to compile it.
# font-dejavu is a RUNTIME dependency: the shareable result card rasterizes SVG
# text with sharp, and Alpine ships no fonts by default. sharp itself needs no
# extra libs here — it ships prebuilt libvips binaries for linux-x64-musl on
# Node 20 (@img/sharp-linuxmusl-x64). If an unsupported platform ever forces a
# source build, sharp would need additional build deps; the supported
# linux-x64-musl target uses the prebuilt binary.
RUN apk add --no-cache python3 make g++ font-dejavu

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=4000
ENV HOST=0.0.0.0

# data/ holds the SQLite DB; mount a volume for persistence.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 4000
CMD ["npm", "start"]