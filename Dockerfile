# A.S.S. Score production image — Node 20 on Alpine
FROM node:20-alpine

# better-sqlite3 has no musl prebuilds, so we need a C toolchain to compile it.
RUN apk add --no-cache python3 make g++

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