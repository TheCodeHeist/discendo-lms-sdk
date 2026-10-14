---
description: An index of all domain and service modules in Discendo SDK, including subpaths, entities, and enforcement capabilities.
---

# Module Reference

Discendo SDK is divided into focused modules. Every module can be imported independently from its own package subpath (`discendo-sdk/<module>`), ensuring you only load the code your application actually uses.

---

## Import Map

| Module                                       | Subpath Export                     | Primary Responsibilities                                                                                                                           |
| -------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| [**Core**](/modules/core)                    | `discendo-sdk/core`                | Shared domain types (`Course`, `Section`, `Enrollment`…), `RepositoryContext`, `EventBus`, RBAC policy engine, multi-tenancy assertions            |
| [**Enrollment**](/modules/enrollment)        | `discendo-sdk/enrollment`          | Student enrollment, waitlists & auto-promotion, seat capacity, roster imports, self-service enrollment requests, student groups, prerequisites     |
| [**Content**](/modules/content)              | `discendo-sdk/content`             | Content hierarchy (pages, assignments, quizzes, files), publishing workflows, versioning, unlocking & gating                                       |
| [**Assessment**](/modules/assessment)        | `discendo-sdk/assessment`          | Assignment submissions, attempt limits, randomized quizzes, scoring rubrics, peer reviews, plagiarism check hooks                                  |
| [**Grading**](/modules/grading)              | `discendo-sdk/grading`             | Immutable grade history (`supersededBy`), weighted final grade calculation, late penalties, letter grades, time extensions, excusals, curves & GPA |
| [**Delegation**](/modules/delegation)        | `discendo-sdk/delegation`          | Instructors granting specific delegable privileges to Teaching Assistants within a section                                                         |
| [**Guardians**](/modules/guardians)          | `discendo-sdk/guardians`           | Read-only portal links for parents/guardians to inspect their student's grades and attendance                                                      |
| [**Scheduling**](/modules/scheduling/)       | `discendo-sdk/scheduling`          | Recurring class routines, calendar occurrences, room matching, teacher availability rules, timetable conflict detection, auto-scheduling solver    |
| [**Calendar**](/modules/scheduling/calendar) | `discendo-sdk/scheduling/calendar` | Open/locked/closed date availability windows and standard iCalendar (`.ics`) due date exports                                                      |
| [**Communication**](/modules/communication)  | `discendo-sdk/communication`       | Section announcements, discussion threads, event-to-notification push/email bridge                                                                 |
| [**Reporting**](/modules/reporting)          | `discendo-sdk/reporting`           | Attendance recording, section completion percentages, grade export formatting                                                                      |
| [**Admin**](/modules/admin)                  | `discendo-sdk/admin`               | Security audit logging wrapper (`withAudit`), tenant-isolated audit log viewer (`AdminService`)                                                    |
| [**Interop**](/modules/interop)              | `discendo-sdk/interop`             | Type-only protocol seams for LTI 1.3, SAML/OIDC SSO, and SCORM/xAPI packages                                                                       |

---

## The Golden Rule of Architecture

> **A module may import only `core` and its own internal files. It never imports another domain or service.**

Cross-module collaboration occurs strictly through:

1. The shared, typed [`EventBus`](/concepts/events)
2. Host-provided locator functions (e.g. `SubmissionLocator`)
3. Orchestration by your application's API controllers

This isolation is enforced automatically by CI tests.

---

## Common Module Structure

Every domain and service documentation page follows a standardized format:

1. **At a Glance:** What you import, what repository interfaces you implement, which events are emitted, and which permission actions are evaluated.
2. **Domain Models & Types:** Complete TypeScript interface definitions.
3. **Services & Operations:** Method signatures, business invariants, and error behaviors.
4. **Pure Calculation Functions:** Standalone calculation utilities (if any).
5. **Permissions & Security:** Rules checked and actor requirements.
6. **Events:** Typed payloads dispatched on mutations.
7. **Known Limitations:** Clear statements of what is deliberately not yet supported or out of scope.
