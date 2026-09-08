# A.S.S. Score production image — multi-stage build on Alpine.
#
# Stage 1 (builder) installs ALL production dependencies so native modules are
# compiled/placed there; stage 2 (runtime) copies only what the app needs to
# run into a slim node:20-alpine image.

# ---------- Stage 1: builder ----------
FROM node:20-alpine AS builder
# better-sqlite3 publishes no musl prebuilds, so a C toolchain is required to
# compile it here. The resulting .node binary is copied into the runtime stage
# (same base image => same libc/arch, so no rebuild needed there).
# sharp needs NO build deps: it ships prebuilt libvips binaries for
# linux-x64-musl on Node 20 (@img/sharp-linuxmusl-x64).
# nodemailer and cheerio are pure JS.
RUN apk add --no-cache python3 make g++
WORKDIR /app
# Install dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---------- Stage 2: runtime ----------
FROM node:20-alpine
# font-dejavu is a RUNTIME dependency: the shareable result card rasterizes
# SVG text with sharp, and Alpine ships no fonts by default (SVG text would
# render blank without it).
RUN apk add --no-cache font-dejavu
WORKDIR /app
ENV NODE_ENV=production
# Railway (and other PaaS) inject PORT at runtime; the app binds
# process.env.PORT || 4000 (see src/server.js). 4000 is only the fallback
# when PORT is unset. HOST must stay 0.0.0.0 inside a container.
ENV PORT=4000
ENV HOST=0.0.0.0
# Copy only what the app needs to run: package metadata, production
# node_modules, and src/ (includes JSON assets like src/rules/fingerprints.json).
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY src ./src
# data/ holds the SQLite DB (default DB_PATH ./data/ass-score.db). On Railway
# the disk is ephemeral — attach a volume and set DB_PATH to the mount for
# persistence. Prepare the dir and run as the non-root node user.
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 4000
CMD ["npm", "start"]
