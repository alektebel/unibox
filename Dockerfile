# syntax=docker/dockerfile:1

# ---- deps: compile native deps, fetch the git-based libsignal ----
FROM node:26-bookworm-slim AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/* \
 && git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"
WORKDIR /app
COPY package.json package-lock.json ./
# package.json carries the npm 12 script approvals ("allowScripts")
RUN npm install --allow-git=all --no-audit --no-fund

# ---- runtime ----
FROM node:26-bookworm-slim AS runtime
# Everything that must survive a redeploy lives under /data, so hosts that give
# one persistent volume per app (NaN Apps, Fly) need a single mount.
ENV NODE_ENV=production \
    UNIBOX_HOST=0.0.0.0 \
    UNIBOX_DATA_DIR=/data \
    UNIBOX_SESSION_DIR=/data/session \
    UNIBOX_DIGESTS_DIR=/data/digests \
    UNIBOX_MEDIA_DIR=/data/media \
    UNIBOX_WHATSAPP_DIR=/data/inbound/whatsapp \
    UNIBOX_NOTES_DIR=/data/inbound/notes \
    UNIBOX_LINKEDIN_DIR=/data/inbound/linkedin
WORKDIR /app
RUN mkdir -p /data
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY web ./web
COPY scripts ./scripts
# Runs as root on purpose: managed volumes (NaN Apps' PVCs) are often mounted
# root-owned, and an unprivileged user couldn't create the database there.
EXPOSE 8124
VOLUME ["/data"]
CMD ["npx", "tsx", "src/index.ts", "serve"]
