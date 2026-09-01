# ContextBridge Backend - Production Dockerfile
# Uses tsx to run TypeScript directly (same as dev mode)

FROM node:20-alpine

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy root config
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc* ./

# Copy Source Code
COPY packages/shared ./packages/shared
COPY packages/backend ./packages/backend
COPY packages/website ./packages/website
COPY packages/backend/downloads ./packages/backend/downloads

# Install ALL dependencies (need tsx and devDependencies)
RUN pnpm install

# Environment
ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

WORKDIR /app/packages/backend

# Run with tsx (same as npm run dev, but without watch)
CMD ["npx", "tsx", "src/index.ts"]