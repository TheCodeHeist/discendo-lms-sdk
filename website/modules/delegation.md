---
description: Learn how discendo-sdk/delegation allows instructors to hand selected permissions to Teaching Assistants per section.
---

# Delegation

`discendo-sdk/delegation` allows instructors and administrators to delegate specific, granular permissions to a Teaching Assistant (TA) in a single course section and revoke them at any time.

By default, TAs have baseline permissions (viewing rosters, grading, taking attendance). Delegation allows course instructors to customize TA capabilities—such as granting the ability to post announcements or manage content—without altering global security policies.

---

## At a Glance

|                  |                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| **Import**       | `import { DelegationService, ActionNotDelegableError, NotAnActiveTaError } from 'discendo-sdk/delegation'` |
| **Repositories** | `DelegationRepository` (in `RepositoryContext`), plus `users`, `courses`, `enrollments`                    |
| **Events**       | `delegation.granted`, `delegation.revoked`                                                                 |
| **Permissions**  | `delegation.grant`, `delegation.revoke`, `delegation.view`                                                 |
| **Enforcement**  | **Always on:** Every method requires an `{ actorId }` and a configured `policy`.                           |

---

## Data Model (`TaGrant`)

```ts
interface TaGrant {
  id: Id;
  enrollmentId: Id; // Tied to the TA's section enrollment, NOT user ID
  sectionId: Id;
  action: string; // e.g. 'content.manage'
  grantedBy: Id; // Instructor or admin who created the grant
  grantedAt: Timestamp;
  revokedAt?: Timestamp; // Set when revoked (never deleted)
}
```

### Key Behavioral Principles:

1. **Grants attach to enrollments, not users:** A grant is tied to `enrollmentId`. If a TA drops and re-enrolls, their new enrollment is a fresh record with zero grants.
2. **Permissions never grow downwards:** An instructor can only delegate permissions they personally hold in that section. TAs cannot delegate permissions to others.
3. **Only designated actions are delegable:** An action must declare `delegable: true` in `DEFAULT_RULES`.

---

## Delegable Actions

| Delegable Action                 | Capability Granted to the TA                                       |
| -------------------------------- | ------------------------------------------------------------------ |
| `content.manage`                 | Create, edit, publish, and reorder course content                  |
| `communication.postAnnouncement` | Post section-wide announcements to students                        |
| `enrollment.enroll`              | Enroll new students (also requires `enrollment.grantRole.student`) |
| `enrollment.grantRole.student`   | Grant the student role                                             |
| `assessment.recordOffline`       | Record in-class or manual submissions for students                 |
| `grading.grantExtension`         | Grant deadline time extensions to students                         |
| `grading.excuse`                 | Excuse a student from an assignment                                |
| `scheduling.manageOccurrence`    | Reschedule or cancel specific class meetings                       |
| `scheduling.recordAttendance`    | Take attendance for scheduled meetings                             |
| `reporting.recordAttendance`     | Record attendance through the reporting service                    |

::: danger Non-delegable actions
Actions like `enrollment.bulkEnroll`, `enrollment.promoteWaitlist`, `enrollment.reviewRequest`, and granting staff roles (`instructor`, `admin`) **can never be delegated**.
:::

---

## `DelegationService`

```ts
new DelegationService(
  repos: RepositoryContext,
  options: {
    policy: PermissionPolicy
    delegableActions?: string[]
    events?: EventBus
  }
)
```

### `grant(sectionId, taUserId, action, actor): Promise<TaGrant>`

Grants a privilege to an active TA:

```ts
const grant = await delegation.grant(
  "sec-101",
  "u-ta-bob",
  "communication.postAnnouncement",
  { actorId: "u-prof" },
);
```

- Verifies that the actor has `delegation.grant` permission in the section.
- Verifies that the target user is currently an **active TA** in that section (throws `NotAnActiveTaError` otherwise).
- Verifies that `action` is delegable (throws `ActionNotDelegableError` otherwise).
- Idempotent: If an active grant already exists for that action, the existing grant is returned.
- Emits `delegation.granted`.

### `revoke(grantId, actor): Promise<TaGrant>`

Revokes an existing grant:

```ts
await delegation.revoke(grant.id, { actorId: "u-prof" });
```

- Sets `revokedAt: new Date()`. The record is preserved for auditing.
- Emits `delegation.revoked`.

### `listActiveForTa(sectionId, taUserId, actor): Promise<TaGrant[]>`

Lists all active grants held by a TA in a section.

---

## Errors

| Error                     | Cause                                                                 |
| ------------------------- | --------------------------------------------------------------------- |
| `NotAnActiveTaError`      | Target user is not currently enrolled as an active TA in the section. |
| `ActionNotDelegableError` | The requested action cannot be delegated to a TA.                     |
| `PermissionDeniedError`   | Actor lacks permission or does not hold the action themselves.        |

---

## Known Limitations

- **Section scope only:** Grants cannot be created account-wide or course-wide; they are strictly section-scoped.
- **No expiration timestamps:** Grants remain active until explicitly revoked or until the TA's enrollment ends.
