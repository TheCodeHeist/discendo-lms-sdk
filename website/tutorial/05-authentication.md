---
description: Implement secure password hashing, JWT token issuance, and authentication middleware with Bun and Hono to resolve authenticated users into Discendo actor contexts.
---

# 5. Authentication & Actors

As established in [Design Principles](/concepts/design-principles), **Discendo SDK never authenticates users**. It trusts the `{ actorId }` you pass and verifies everything else against your database.

In this chapter, we will build:

1. User registration with password hashing using Bun's native crypto.
2. A login endpoint that issues signed JSON Web Tokens (JWT).
3. Hono authentication middleware that verifies the JWT and attaches the authenticated `actorId` to the request context.

---

## 1. Password Hashing & JWT Helpers (`src/lib/auth.ts`)

Bun includes native, hardware-accelerated password hashing using Argon2 and bcrypt. We'll also use Hono's built-in JWT module (`hono/jwt`).

Create `src/lib/auth.ts`:

```ts
import { sign, verify } from "hono/jwt";

const JWT_SECRET =
  process.env.JWT_SECRET || "super-secret-academix-key-change-in-prod";

export interface TokenPayload {
  sub: string; // User ID (maps to actorId)
  email: string;
  roles: string[];
  orgId?: string;
  exp: number; // Expiration timestamp
}

// 1. Password Hashing via Bun.password (Argon2id)
export async function hashPassword(password: string): Promise<string> {
  return await Bun.password.hash(password, {
    algorithm: "argon2id",
    memoryCost: 65536,
    timeCost: 3,
  });
}

export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  return await Bun.password.verify(password, hash);
}

// 2. JWT Generation
export async function createAuthToken(user: {
  id: string;
  email: string;
  roles: string[];
  orgId?: string;
}): Promise<string> {
  const payload: TokenPayload = {
    sub: user.id,
    email: user.email,
    roles: user.roles,
    ...(user.orgId ? { orgId: user.orgId } : {}),
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7, // 7 days
  };
  return await sign(payload, JWT_SECRET);
}

// 3. JWT Verification
export async function verifyAuthToken(
  token: string,
): Promise<TokenPayload | null> {
  try {
    return (await verify(token, JWT_SECRET)) as TokenPayload;
  } catch {
    return null;
  }
}
```

---

## 2. Authentication Middleware (`src/lib/middleware.ts`)

Create `src/lib/middleware.ts` to protect routes and inject the verified `actorId`:

```ts
import { createMiddleware } from "hono/factory";
import { verifyAuthToken } from "./auth";
import type { TokenPayload } from "./auth";

// Extend Hono's environment typing
export type AppEnv = {
  Variables: {
    user: TokenPayload;
    actorId: string;
  };
};

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json(
      {
        error: "Unauthorized",
        message: "Missing or malformed Authorization header",
      },
      401,
    );
  }

  const token = authHeader.slice(7);
  const payload = await verifyAuthToken(token);

  if (!payload) {
    return c.json(
      { error: "Unauthorized", message: "Invalid or expired token" },
      401,
    );
  }

  // Inject into request context
  c.set("user", payload);
  c.set("actorId", payload.sub);

  await next();
});
```

---

## 3. Auth Routes (`src/routes/auth.ts`)

Create `src/routes/auth.ts` with registration and login endpoints:

```ts
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema";
import { hashPassword, verifyPassword, createAuthToken } from "../lib/auth";

export const authRoutes = new Hono();

// Register a new user
authRoutes.post("/register", async (c) => {
  const { name, email, password, roles, orgId } = await c.req.json();

  // Validate input
  if (!name || !email || !password) {
    return c.json(
      { error: "Validation", message: "Name, email, and password required" },
      400,
    );
  }

  const existing = await db.query.users.findFirst({
    where: eq(users.email, email),
  });
  if (existing) {
    return c.json(
      { error: "Conflict", message: "User with this email already exists" },
      409,
    );
  }

  const id = crypto.randomUUID();
  const passwordHash = await hashPassword(password);
  const assignedRoles =
    Array.isArray(roles) && roles.length > 0 ? roles : ["student"];

  await db.insert(users).values({
    id,
    name,
    email,
    passwordHash,
    roles: assignedRoles,
    orgId: orgId ?? null,
    createdAt: new Date(),
  });

  const token = await createAuthToken({
    id,
    email,
    roles: assignedRoles,
    orgId,
  });
  return c.json(
    { ok: true, token, user: { id, name, email, roles: assignedRoles } },
    201,
  );
});

// Login
authRoutes.post("/login", async (c) => {
  const { email, password } = await c.req.json();

  const user = await db.query.users.findFirst({
    where: eq(users.email, email),
  });
  if (!user) {
    return c.json(
      { error: "Unauthorized", message: "Invalid credentials" },
      401,
    );
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    return c.json(
      { error: "Unauthorized", message: "Invalid credentials" },
      401,
    );
  }

  const token = await createAuthToken({
    id: user.id,
    email: user.email,
    roles: user.roles,
    ...(user.orgId ? { orgId: user.orgId } : {}),
  });

  return c.json({
    ok: true,
    token,
    user: { id: user.id, name: user.name, roles: user.roles },
  });
});
```

---

## 4. How the SDK Uses `actorId`

In subsequent chapters, route handlers extract `actorId` directly from the context:

```ts
app.post("/api/sections/:id/enroll", requireAuth, async (c) => {
  const actorId = c.get("actorId"); // Extracted from verified JWT
  const { userId, role } = await c.req.json();
  const sectionId = c.req.param("id");

  // Pass actorId to Discendo service
  const enrollment = await enrollmentService.enroll(
    { userId, sectionId, role },
    { actorId }, // Discendo verifies identity from UserRepository
  );

  return c.json(enrollment);
});
```

Notice that we **never** pass user roles to `enrollmentService.enroll()`. The SDK loads the verified `Identity` from `UserRepository` by `actorId`, guaranteeing that callers cannot spoof administrative privileges.

---

## Next Steps

Now that users can authenticate and obtain verified IDs, we will configure route-level error mapping and access control in [Chapter 6: Roles & Permissions](/tutorial/06-permissions).
