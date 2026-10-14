---
description: Protect HTTP API routes with fail-closed RBAC, build a centralized domain error handler, and customize authorization rules.
---

# 6. Roles & Permissions

In this chapter, we will build a centralized error handler that maps Discendo's domain and authorization exceptions to standard HTTP status codes, and explore how to customize access control rules.

---

## 1. Centralized Error Handler (`src/lib/errors.ts`)

When an SDK service rejects a call, it throws a typed error. Rather than duplicating `try/catch` logic across dozens of routes, create `src/lib/errors.ts`:

```ts
import type { Context } from "hono";
import {
  PermissionDeniedError,
  ActorRequiredError,
  TenantMismatchError,
} from "discendo-sdk/core";
import {
  SectionNotOpenError,
  AlreadyEnrolledError,
  EnrollmentNotDroppableError,
  PrerequisiteNotMetError,
} from "discendo-sdk/enrollment";

export function handleDomainError(c: Context, err: unknown) {
  // 1. Authorization & Security Failures
  if (err instanceof PermissionDeniedError) {
    return c.json(
      {
        error: "Forbidden",
        action: err.action,
        message: "You do not have permission to perform this action",
      },
      403,
    );
  }

  if (err instanceof TenantMismatchError) {
    return c.json(
      {
        error: "TenantMismatch",
        message: "You cannot perform actions across institution boundaries",
      },
      403,
    );
  }

  if (err instanceof ActorRequiredError) {
    console.error(
      "[Critical Bug] Enforcing service invoked without actor context:",
      err,
    );
    return c.json(
      {
        error: "InternalServerError",
        message: "Missing security context",
      },
      500,
    );
  }

  // 2. Academic & Enrollment Domain Failures
  if (err instanceof SectionNotOpenError) {
    return c.json(
      {
        error: "SectionNotOpen",
        sectionId: err.sectionId,
        status: err.status,
        message: err.message,
      },
      400,
    );
  }

  if (err instanceof AlreadyEnrolledError) {
    return c.json(
      {
        error: "AlreadyEnrolled",
        message: "User is already enrolled in this section",
      },
      409,
    );
  }

  if (err instanceof EnrollmentNotDroppableError) {
    return c.json(
      {
        error: "EnrollmentNotDroppable",
        message: "Completed enrollments cannot be dropped",
      },
      400,
    );
  }

  if (err instanceof PrerequisiteNotMetError) {
    return c.json(
      {
        error: "PrerequisitesNotMet",
        courseId: err.courseId,
        unmet: err.unmet,
        message: "Student does not meet prerequisite requirements",
      },
      400,
    );
  }

  // 3. Fallback for unhandled unexpected exceptions
  console.error("[Unhandled Exception]:", err);
  return c.json(
    {
      error: "InternalServerError",
      message:
        err instanceof Error ? err.message : "An unexpected error occurred",
    },
    500,
  );
}
```

---

## 2. Using the Error Handler in Route Endpoints

With `handleDomainError`, your endpoint handlers remain concise and readable:

```ts
app.post("/api/sections/:id/enroll", requireAuth, async (c) => {
  const actorId = c.get("actorId");
  const sectionId = c.req.param("id");
  const { userId, role } = await c.req.json();

  try {
    const enrollment = await enrollmentService.enroll(
      { userId, sectionId, role, waitlistIfFull: true },
      { actorId },
    );
    return c.json({ ok: true, enrollment }, 201);
  } catch (err) {
    return handleDomainError(c, err);
  }
});
```

### What Happens When Access Is Denied:

1. If a student attempts to enroll another user, `enrollmentService.enroll()` detects that `'student'` lacks `enrollment.enroll`.
2. It throws `PermissionDeniedError('enrollment.enroll')` **before running any database lookups**.
3. `handleDomainError` catches the exception and returns:
   ```json
   {
     "error": "Forbidden",
     "action": "enrollment.enroll",
     "message": "You do not have permission to perform this action"
   }
   ```
   with HTTP status `403 Forbidden`.

---

## 3. Customizing the Policy Rules

In `src/lib/services.ts`, we used `createRolePolicy()`, which applies `DEFAULT_RULES`. If your institution requires custom permissions—such as allowing Teaching Assistants to drop students—you override specific action rules:

```ts
import { createRolePolicy } from "discendo-sdk/core";

export const policy = createRolePolicy({
  rules: {
    // Override: Allow TAs to drop students in their section
    "enrollment.drop": {
      roles: ["admin", "instructor", "ta"],
      allowSelf: true, // Students can still drop themselves
    },

    // Override: Allow instructors to view the audit log for their sections
    "admin.viewAuditLog": {
      roles: ["admin", "instructor"],
    },
  },
});
```

All other rules retain their secure defaults.

---

## Next Steps

Next, we will explore multi-tenant data boundaries in [Chapter 7: Organizations & Departments](/tutorial/07-organizations).
