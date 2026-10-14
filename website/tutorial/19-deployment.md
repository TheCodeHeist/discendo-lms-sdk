---
description: Containerize your Bun LMS application with Docker, migrate from SQLite to PostgreSQL, and deploy to production.
---

# 19. Deployment

In this final chapter, we will prepare Academix for production by switching to a PostgreSQL database, creating a multi-stage Dockerfile, and deploying the service.

---

## 1. Migrating from SQLite to PostgreSQL

SQLite is ideal for development and local testing. For production deployments with multiple API replicas, connect Drizzle ORM to PostgreSQL:

### Install Postgres Driver:

```sh
bun add postgres
```

### PostgreSQL Schema & Connection (`src/db/index.pg.ts`):

```ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.pg";

const connectionString = process.env.DATABASE_URL!;

// Connect with connection pooling
export const client = postgres(connectionString, { max: 10 });
export const db = drizzle(client, { schema });
```

Because Discendo communicates exclusively through your repository interfaces, **zero SDK logic needs to change** when switching databases. Only the internal Drizzle repository queries are adapted from SQLite to PostgreSQL.

---

## 2. Production Dockerfile

Create a lightweight, multi-stage `Dockerfile` using the official `oven/bun` image:

```dockerfile
# Stage 1: Build & Dependencies
FROM oven/bun:1.1-alpine AS builder
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src/ ./src/

# Stage 2: Production Runtime
FROM oven/bun:1.1-distroless AS runner
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/package.json ./package.json

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["run", "src/index.ts"]
```

Distroless images contain no package managers or shell binaries, keeping the final container under **80MB** with minimal attack surface.

---

## 3. Environment Variables Configuration

Configure your production environment variables:

| Variable       | Description                             | Example                                          |
| -------------- | --------------------------------------- | ------------------------------------------------ |
| `NODE_ENV`     | Environment mode                        | `production`                                     |
| `PORT`         | HTTP listener port                      | `3000`                                           |
| `DATABASE_URL` | PostgreSQL connection string            | `postgres://user:pass@db.internal:5432/academix` |
| `JWT_SECRET`   | 256-bit cryptographically random secret | `openssl rand -hex 32`                           |

---

## 4. Production Startup & Migrations

In your container entrypoint or CI/CD deployment pipeline, run database migrations before starting the web server:

```sh
# Run pending Drizzle migrations
bunx drizzle-kit migrate

# Start the application
bun run src/index.ts
```

---

## Summary: What You Have Built

Congratulations! You have built a complete, production-ready Learning Management System backend:

- **Clean Architecture:** Strict separation between persistence (Drizzle), domain logic (Discendo), and HTTP routing (Hono).
- **Hardened Security:** Fail-closed role-based access control, Argon2id passwords, and multi-tenant tenant isolation.
- **Academic Rigor:** Atomic seat registration, automatic waitlist promotion, immutable grade audit trails, and backtracking timetable scheduling.

---

## What to Explore Next

- Dive into individual SDK domains in the [Module Reference](/modules/).
- Build a front-end client using React, Vue, Svelte, or Next.js.
- Plug in real notification providers (SendGrid, Firebase) via `NotificationSink`.
