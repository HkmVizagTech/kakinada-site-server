# syntax=docker/dockerfile:1

# ── Stage 1: install dependencies and generate the Prisma client ──────────
# prisma (the CLI) is a runtime dependency, not a devDependency, because
# migrations run on boot. See package.json.
FROM node:22-alpine AS deps

# Prisma's query engine needs OpenSSL, which node:alpine does not ship.
RUN apk add --no-cache openssl

WORKDIR /usr/src/app

# The schema must be present before `npm ci`, because the postinstall hook
# runs `prisma generate` as part of the install.
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci
# Generate explicitly rather than trusting the postinstall hook: newer npm
# versions gate install scripts behind an allow-list, and a silently skipped
# `prisma generate` would ship a stub client that fails on the first query.
RUN npx prisma generate

# ── Stage 2: runtime ──────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

RUN apk add --no-cache openssl

WORKDIR /usr/src/app
ENV NODE_ENV=production

# The whole node_modules tree comes across. `prisma migrate deploy` in CMD
# needs the CLI, which is why the CLI is a runtime dependency rather than a
# devDependency -- this stage is therefore a normal full install.
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY . .

# There is no fixed port to expose: index.js binds to process.env.PORT, which
# Railway injects. EXPOSE is documentation only, so keep it on the app's
# documented default rather than implying a hard-coded port.
EXPOSE 8080

# Apply migrations on boot via scripts/migrate-deploy.js, which wraps
# `prisma migrate deploy` so that a migration left in a failed state (P3009)
# is cleared and retried once instead of crash-looping the container. It is a
# no-op when the database is already up to date, and it still fails the deploy
# loudly on any other error rather than booting against a broken schema.
# Requires DATABASE_URL and a `prisma` CLI; if you would rather migrate as a
# separate release step, delete this line and run `npx prisma migrate deploy`
# from a machine with the dev dependencies installed.
CMD ["sh", "-c", "node scripts/migrate-deploy.js && node index.js"]
