---
description: Bootstrap your LMS project with Bun, install Hono and Drizzle ORM, configure TypeScript with strict flags, and organize the project folder structure.
---

# 1. Project Setup

In this chapter, we will scaffold the project, configure TypeScript for strict type safety, install our dependencies, and set up the directory structure.

---

## Prerequisites

- [**Bun**](https://bun.sh) 1.1+ installed on your system. Verify with `bun --version`.

---

## 1. Initialize the Project

Create a new directory for your LMS application and initialize a Bun package:

```sh
mkdir academix && cd academix
bun init -y
```

---

## 2. Install Dependencies

Install the core web framework, database libraries, and Discendo SDK:

::: code-group

```sh [bun (local SDK build)]
# 1. Web framework & database tools
bun add hono drizzle-orm

# 2. Discendo SDK (linking to local build until published to npm)
bun add ../discendo-lms-sdk

# 3. Development tooling
bun add -d drizzle-kit typescript @types/bun
```

```sh [bun (from npm)]
# Once discendo-sdk is published to npm
bun add hono drizzle-orm discendo-sdk
bun add -d drizzle-kit typescript @types/bun
```

:::

---

## 3. Configure TypeScript (`tsconfig.json`)

Discendo SDK is compiled with strict TypeScript flags. To ensure type compatibility and catch bugs early, configure your `tsconfig.json`:

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleDetection": "force",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true
  },
  "include": ["src"]
}
```

---

## 4. Project Directory Layout

Organize your application into clear layers separating data persistence, domain service wiring, and HTTP transport:

```sh
mkdir -p src/db/repositories src/lib src/routes
```

Your project directory will look like this:

```
academix/
├── package.json
├── tsconfig.json
├── drizzle.config.ts        # Drizzle migration configuration
├── sqlite.db                # Local development database
└── src/
    ├── index.ts             # Application entrypoint & HTTP server
    ├── db/
    │   ├── schema.ts        # Drizzle ORM table definitions
    │   ├── index.ts         # Database connection client
    │   └── repositories/    # Concrete Discendo repository implementations
    │       ├── users.ts
    │       ├── courses.ts
    │       ├── enrollments.ts
    │       ├── content.ts
    │       └── grades.ts
    ├── lib/
    │   ├── services.ts      # Global SDK service container
    │   ├── auth.ts          # JWT authentication helpers & middleware
    │   └── errors.ts        # Domain error to HTTP response mappers
    └── routes/              # Hono route handlers
        ├── auth.ts
        ├── courses.ts
        ├── enrollments.ts
        ├── content.ts
        └── grades.ts
```

---

## 5. Create a "Hello World" Hono Server

Verify that Bun and Hono are functioning by creating `src/index.ts`:

```ts
import { Hono } from "hono";

const app = new Hono();

app.get("/health", (c) => {
  return c.json({ status: "ok", time: new Date().toISOString() });
});

export default {
  port: 3000,
  fetch: app.fetch,
};
```

Run the server:

```sh
bun run --hot src/index.ts
```

Open another terminal and verify the endpoint:

```sh
curl http://localhost:3000/health
# {"status":"ok","time":"2026-10-13T12:00:00.000Z"}
```

---

## Next Steps

With our project structure in place, we are ready to design our relational database schema in [Chapter 2: Database Schema](/tutorial/02-database-schema).
