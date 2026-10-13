---
description: Learn how Discendo SDK enforces role-based access control (RBAC), the default rules table, fail-closed guarantees, and custom policies.
---

# Permissions

`discendo-sdk/core` contains a role-based access control engine. Every service in the SDK can enforce permissions automatically before performing database lookups or mutations.

---

## The Golden Rule: The SDK Does Not Authenticate

The SDK has no concept of sessions, passwords, JWTs, cookies, or OAuth:

1. **Authentication is your job:** Your web framework verifies incoming credentials and extracts the user's ID.
2. **Authorization is the SDK's job:** You pass `{ actorId }` to the service method. The SDK loads that user's record from your `UserRepository` and verifies their permissions against the requested resource.

::: danger Never trust input roles
The SDK never accepts roles passed in request parameters. It loads the actor's verified `Identity` from database persistence on every call.
:::

---

## Turning Enforcement On

Permissions are **opt-in per service**. If you omit the `{ policy }` option, the service trusts the caller and skips authorization checks:

```ts
import { createRolePolicy } from "discendo-sdk/core";
import { EnrollmentService } from "discendo-sdk/enrollment";

// Create policy with default rules
const policy = createRolePolicy();

// Enable enforcement on the service
const enrollment = new EnrollmentService(repos, bus, { policy });

// Every call now requires an actor context
await enrollment.enroll(
  { userId: "stu-1", sectionId: "sec-101", role: "student" },
  { actorId: currentUser.id }, // The verified caller ID
);
```

### Error Responses

| Error                   | Cause                                                          | HTTP Mapping         |
| ----------------------- | -------------------------------------------------------------- | -------------------- |
| `PermissionDeniedError` | Actor lacks required role, target not found, or policy refused | `403 Forbidden`      |
| `ActorRequiredError`    | Enforcing service was invoked without `{ actorId }`            | `500 Internal Error` |
| `TenantMismatchError`   | Actor and resource belong to different organizations           | `403 Forbidden`      |

---

## Roles

The SDK defines exactly four roles:

```ts
type Role = "student" | "instructor" | "ta" | "admin";
```

A role can exist in two distinct scopes:

1. **Section Role (`Enrollment.role`):** What someone is inside one specific section. Checked for all section-scoped operations (grading, viewing content, taking quizzes). **Only `active` enrollments count**; waitlisted, dropped, or completed enrollments grant no operational permissions.
2. **Account Role (`Identity.roles`):** What someone is system-wide. For section-scoped actions, **only `admin` is honored** system-wide. An account with `Identity.roles = ['instructor']` cannot grade sections they are not enrolled in as an instructor.

::: info Guardians are not a role
A parent or guardian does not hold a `Role`. They access student data through verified [Guardian Links](/modules/guardians).
:::

---

## The Default Rules Table (`DEFAULT_RULES`)

The default policy defines access rules across every action:

| Action                            | Allowed Roles                          | Own Resource Only         | Delegable to TA |
| --------------------------------- | -------------------------------------- | ------------------------- | --------------- |
| **Enrollment**                    |                                        |                           |                 |
| `enrollment.enroll`               | `admin`, `instructor`                  | —                         | Yes             |
| `enrollment.bulkEnroll`           | `admin`                                | —                         | No              |
| `enrollment.drop`                 | `admin`, `instructor`                  | `student` (can drop self) | No              |
| `enrollment.viewRoster`           | `admin`, `instructor`, `ta`            | —                         | No              |
| `enrollment.promoteWaitlist`      | `admin`, `instructor`                  | —                         | No              |
| `enrollment.reviewRequest`        | `admin`                                | —                         | No              |
| `enrollment.grantRole.admin`      | `admin`                                | —                         | No              |
| `enrollment.grantRole.instructor` | `admin`                                | —                         | No              |
| `enrollment.grantRole.ta`         | `admin`, `instructor`                  | —                         | No              |
| `enrollment.grantRole.student`    | `admin`, `instructor`                  | —                         | Yes             |
| `enrollment.manageGroups`         | `admin`, `instructor`                  | —                         | No              |
| **Content**                       |                                        |                           |                 |
| `content.view`                    | `admin`, `instructor`, `ta`, `student` | —                         | No              |
| `content.manage`                  | `admin`, `instructor`                  | —                         | Yes             |
| **Assessment**                    |                                        |                           |                 |
| `assessment.submit`               | —                                      | `student` only            | No              |
| `assessment.startAttempt`         | —                                      | `student` only            | No              |
| `assessment.answerQuiz`           | —                                      | `student` only            | No              |
| `assessment.submitQuiz`           | —                                      | `student` only            | No              |
| `assessment.viewAttempts`         | `admin`, `instructor`, `ta`            | `student` (own attempts)  | No              |
| `assessment.recordOffline`        | `admin`, `instructor`                  | —                         | Yes             |
| `assessment.manageRubric`         | `admin`, `instructor`                  | —                         | No              |
| **Grading**                       |                                        |                           |                 |
| `grading.record`                  | `admin`, `instructor`, `ta`            | —                         | Yes             |
| `grading.viewGrades`              | `admin`, `instructor`, `ta`            | `student` (own grades)    | No              |
| `grading.computeFinal`            | `admin`, `instructor`, `ta`            | —                         | No              |
| `grading.manageExtensions`        | `admin`, `instructor`                  | —                         | Yes             |
| `grading.manageExcusals`          | `admin`, `instructor`                  | —                         | Yes             |
| `grading.manageCurve`             | `admin`, `instructor`                  | —                         | No              |
| **Scheduling**                    |                                        |                           |                 |
| `scheduling.view`                 | `admin`, `instructor`, `ta`, `student` | —                         | No              |
| `scheduling.manage`               | `admin`, `instructor`                  | —                         | No              |
| `scheduling.cancelOccurrence`     | `admin`, `instructor`                  | —                         | No              |
| **Communication**                 |                                        |                           |                 |
| `communication.postAnnouncement`  | `admin`, `instructor`                  | —                         | Yes             |
| `communication.reply`             | `admin`, `instructor`, `ta`, `student` | —                         | No              |
| **Reporting**                     |                                        |                           |                 |
| `reporting.recordAttendance`      | `admin`, `instructor`, `ta`            | —                         | No              |
| `reporting.viewReports`           | `admin`, `instructor`                  | —                         | No              |
| **Admin**                         |                                        |                           |                 |
| `admin.viewAuditLog`              | `admin`                                | —                         | No              |
| `admin.manageDelegations`         | `admin`, `instructor`                  | —                         | No              |

---

## Customizing Rules

You can override individual actions without writing a policy from scratch:

```ts
import { createRolePolicy } from "discendo-sdk/core";

const customPolicy = createRolePolicy({
  rules: {
    // Allow teaching assistants to drop students
    "enrollment.drop": {
      roles: ["admin", "instructor", "ta"],
      allowSelf: true,
    },
    // Allow instructors to view the admin audit log for their sections
    "admin.viewAuditLog": {
      roles: ["admin", "instructor"],
    },
  },
});
```

---

## Fail-Closed Security Guarantees

The permission subsystem follows strict defensive programming:

1. **Authorization runs first:** The service checks permissions before looking up the target entity.
2. **Identical errors:** If a target ID does not exist, the service throws `PermissionDeniedError` rather than a 404 or entity not found error. This prevents attackers from guessing private IDs.
3. **No role spoofing:** Even if a malicious request injects `{ role: 'admin' }`, the SDK only inspects verified records returned from `UserRepository`.

---

## TA Delegation and Guardians

- **Teaching Assistants:** An instructor can delegate specific privileges (marked **Delegable** in the table above) to a TA using `DelegationService`. The authorization engine checks active `TaGrant` records automatically. See [Delegation](/modules/delegation).
- **Parents & Guardians:** Parents access student records with `GuardianScope` links. The authorization engine checks `GuardianLinkRepository` to allow parents to view their ward's grades and attendance. See [Guardians](/modules/guardians).

---

## Next Steps

- Learn how multi-institution tenant barriers work in [Tenancy](/concepts/tenancy).
- Review the [Module Reference](/modules/) to see which permissions apply to each service.
