# Copilot Instructions — hyperlms-sdk

This is a **framework- and database-agnostic** LMS logic SDK. It ships as a
TypeScript library that host apps `bun install` / `npm install` into their
own project (Next.js, Express, whatever) and wire up to their own database.
Any suggestion that assumes a specific DB, ORM, or web framework is wrong —
treat that as a hard constraint, not a style preference.

## Toolchain

- Runtime/package manager: **Bun**. Tests run with `bun test` (imports from
  `bun:test`, not `vitest` or `jest`). `bun run typecheck` runs `tsc --noEmit`.
- Build output (`tsc -p tsconfig.json`) targets Node/browser consumers too —
  don't suggest Bun-only APIs (`Bun.serve`, `Bun.file`, etc.) inside `src/`.
  Bun-specific code is fine in `test/` only.
- Module resolution is `NodeNext` — always include `.js` extensions in
  relative imports, even though the source files are `.ts`:
  `import { Foo } from './foo.js'` — not `'./foo'` or `'./foo.ts'`.

## Architecture rules (don't deviate without being asked)

1. **No concrete DB/ORM imports in `src/`.** Every module that needs
   persistence defines a `*Repository` interface (see `core/repositories.ts`,
   `grading/service.ts`) and takes it as a constructor dependency. The host
   app implements the interface against Prisma/Drizzle/raw SQL/whatever.
   Never suggest `import { PrismaClient } from '@prisma/client'` or similar
   inside `src/`.

2. **Course vs CourseSection stay separate.** `Course` is a template,
   `CourseSection` is a running instance (with its own term, capacity,
   status). Don't collapse these into one entity.

3. **Never hard-delete or overwrite history.** Enrollments get a `status`
   flip (`dropped`), not a `DELETE`. Grades get a new `GradeEntry` with the
   old one marked `supersededBy`, never an in-place score update. If you're
   about to suggest a destructive update on core entities, stop and use the
   append/status-flip pattern instead.

4. **Grading/scheduling logic is pure functions, not service methods,
   wherever possible.** See `grading/calculations.ts` — `computeFinalGrade`,
   `applyLatePolicy`, `toLetterGrade` take plain data in, return plain data
   out, no repository access. This is what makes them trivially unit
   testable and reusable for "preview this grade before committing" flows.
   Put orchestration (repo calls, event dispatch) in the `*Service` class;
   put calculation in a sibling pure-function file.

5. **Grading scale, weighting, and late policy are always config passed in
   at call time** (`GradingScheme`, `GradeScale`, `LatePolicy`), never
   hardcoded constants. Every institution's rules differ — if you're
   tempted to write `if (percent >= 90) return 'A'`, that should be a
   `GradeScale` parameter instead.

6. **Timestamps are UTC everywhere in `src/`.** Timezone conversion is a
   host-app presentation concern. Never suggest `new Date().toLocaleString()`
   or similar inside SDK logic.

7. **The SDK never sends notifications/emails itself.** Modules that need
   to notify someone construct a typed `NotificationEvent` and hand it to
   a `NotificationSink` interface the host app implements. Same pattern for
   plagiarism checks (`PlagiarismCheckHook`) and LTI/SSO
   (`AuthProvider`, `LtiLaunchHandler`) — these are seams, not
   implementations. Don't write actual SMTP, SAML, or OAuth handshake code
   in this repo.

8. **Every mutating service method should be safe to call twice.**
   `EnrollmentService.enroll` is idempotent (returns the existing active
   enrollment rather than duplicating). Default to this pattern for new
   service methods unless there's a specific reason not to.

## Module layout convention

Each domain module under `src/<module>/` follows:

- `types.ts` — domain types/interfaces specific to this module
- `service.ts` — the `*Service` class (constructor-injected repos), plus any
  `*Repository` interfaces this module owns
- `calculations.ts` — pure functions only, where relevant (grading, calendar)
- `index.ts` — barrel export (`export * from './types.js'` etc.)

New modules should follow this same shape. `enrollment/` and `grading/` are
the most fleshed-out reference examples — model new service code on those.

## Testing conventions

- Tests live in `test/`, not next to source files.
- Prefer testing pure functions (`calculations.ts`) directly and heavily —
  they're the cheapest, most valuable tests in this codebase.
- For service classes, construct with lightweight in-memory fakes of the
  repository interfaces rather than mocking libraries.

## What NOT to suggest

- Concrete database clients, ORMs, or query builders in `src/`
- `localStorage`/browser-only or Node-only (`fs`, `path` for app logic)
  APIs in `src/` — this code must run in any JS environment
- Framework-specific code (React hooks, Express middleware, Next.js route
  handlers) inside `src/` — that glue belongs in the host app, not the SDK
- Hardcoded grading scales, late-penalty percentages, or role lists —
  these are always caller-supplied config
- Email/SMS/push sending, SAML/OIDC/LTI protocol implementations — expose
  an interface instead and let the host app plug in a real library
