---
description: Learn how discendo-sdk/guardians provides parents and guardians with read-only access to their ward's academic records.
---

# Guardians

`discendo-sdk/guardians` provides read-only access for parents and guardians of minor students, allowing them to view grades, attendance, class routines, and guardian announcements without enrolling them in courses or giving them write permissions.

---

## At a Glance

|                  |                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| **Import**       | `import { GuardianService } from 'discendo-sdk/guardians'`                                      |
| **Repositories** | `GuardianLinkRepository` (read), `GuardianLinkManagementRepository` (management)                |
| **Events**       | `guardians.linkCreated`, `guardians.linkRevoked`                                                |
| **Permissions**  | Managed exclusively by account-wide `admin` users                                               |
| **Enforcement**  | Evaluated automatically by `authorizeInSection` whenever `guardianLinks` repository is provided |

---

## The Model: Links, Not Roles

::: important Guardians are not a role
There is no `'guardian'` value in `Role`, no guardian enrollment, and no course-level membership.
:::

A guardian is a user connected to a student via an explicit **`GuardianLink`**:

```ts
type GuardianScope = "grades" | "attendance" | "schedule" | "announcements";

interface GuardianLink {
  id: Id;
  guardianId: Id;
  wardId: Id;
  orgId?: Id; // Tenant wall
  scopes: GuardianScope[]; // Granular read-only scopes
  status: "active" | "revoked";
  createdAt: Timestamp;
  revokedAt?: Timestamp;
}
```

- **One link per pair:** A parent with two children has two distinct links. A student with two parents has two links with potentially different scopes.
- **Never deleted:** Revoking flips `status` to `'revoked'` and records `revokedAt`.

---

## Scopes & Capabilities

Each scope unlocks exactly one read-only capability:

| Scope           | Unlocked Permission                       | What the Guardian Can See                             |
| --------------- | ----------------------------------------- | ----------------------------------------------------- |
| `grades`        | `grading.view`                            | The ward's assignment scores and final weighted grade |
| `attendance`    | `reporting.view`                          | The ward's attendance marks and summaries             |
| `schedule`      | `scheduling.view`                         | The ward's scheduled class routine                    |
| `announcements` | `communication.viewGuardianAnnouncements` | Announcements specifically addressed to guardians     |

### What Guardians Can Never Do:

- **Never write:** Guardians cannot submit assignments, take quizzes, post discussion replies, or edit rosters.
- **No peer data:** Guardians cannot see other students' grades, attendance, or roster presence.
- **No course content:** Guardians cannot browse course modules, reading materials, or files.

---

## How Access Is Verified

When a caller requests a student's records (`actorId !== ownerId`), the authorization engine (`core/authorization.ts`) verifies **all 7 conditions**:

1. An active `GuardianLink` exists between `actorId` and `ownerId`.
2. The link status is `'active'`.
3. The link explicitly matches the specified guardian and ward.
4. The link's `orgId` matches the course section's organization.
5. **The ward has an active student enrollment in that section.** If the student drops, completes, or is waitlisted, guardian access terminates instantly.
6. The action rule includes a `guardianScope`, and the link grants that scope.
7. The policy confirms the actor is not their own ward.

If any check fails, access is refused with `PermissionDeniedError`.

---

## `GuardianService`

The administration service for managing parent-student relationships:

```ts
new GuardianService(
  repos: RepositoryContext,
  managementRepo: GuardianLinkManagementRepository,
  events?: EventBus,
  options?: { policy?: PermissionPolicy }
)
```

### `createLink(opts, actor): Promise<GuardianLink>`

Creates a link between a guardian and a student:

```ts
const link = await guardianService.createLink(
  {
    guardianId: "u-parent",
    wardId: "u-student",
    scopes: ["grades", "attendance", "announcements"],
  },
  { actorId: "u-admin" },
);
```

- Requires account-wide `admin` role.
- Enforces strict tenant equality: the admin, guardian, and ward must all belong to the same organization.
- Emits `guardians.linkCreated`.

### `revokeLink(linkId, actor): Promise<GuardianLink>`

Revokes an existing link:

```ts
await guardianService.revokeLink(link.id, { actorId: "u-admin" });
```

- Sets `status: 'revoked'` and `revokedAt: new Date()`.
- Emits `guardians.linkRevoked`.

### `listGuardiansForSection(sectionId, scope?, actor?): Promise<string[]>`

Returns a list of guardian user IDs who should receive notifications for students in a given section. Used by communication services to deliver guardian announcements.

---

## Known Limitations

- **No self-service enrollment linking:** Links must be established by administrators or synchronized via SIS integration; there is no self-service student consent workflow.
