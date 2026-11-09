# Store Hub — Licence backend Dockerfile
# Multi-stage build: compile nothing (pure Node), just copy and run.
# Required env: SUPABASE_DB_URL, STOREHUB_PEPPER, GOOGLE_* (for auth),
# STOREHUB_ADMIN_SUB (for admin portal). See ENV_VARIABLES.md.

FROM node:22-alpine

WORKDIR /app

# Install production dependencies only
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# Copy server source
COPY server/src ./src
COPY server/supabase ./supabase

# Copy web assets served by the backend (app shell + admin portal)
COPY index.html manifest.json sw.js ./
COPY css ./css
COPY fonts ./fonts
COPY icons ./icons
COPY js ./js
COPY admin ./admin
COPY vendor ./vendor

# Non-root user for security
RUN addgroup -S storehub && adduser -S storehub -G storehub
USER storehub

# Port the backend listens on (overridable via PORT env)
ENV PORT=8787
ENV HOST=0.0.0.0
ENV NODE_ENV=production
# src/ lives in /app/src, so the default web root (src/../..) would be '/'.
ENV STOREHUB_WEB_ROOT=/app

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:8787/api/health || exit 1

CMD ["node", "src/index.js"]
