# DiscendoLMS SDK | A framework-agnostic SDK for any Learning Management System (LMS)

> **STILL IN EARLY DEVELOPMENT — expect breaking changes and incomplete coverage. The SDK is not yet ready for production use.**

A framework- and database-agnostic TypeScript SDK of LMS (Learning Management System) logic, built on Bun. The SDK provides typed domain models, pure calculation functions, and repository-interface-driven services for the core concerns of a learning platform — from a single-tutor setup to a multi-department university.

It never assumes a specific database, ORM, web framework, or UI: every module exposes interfaces the host application implements against whatever stack it already uses.

This SDK aims to standardize the core LMS logic so that different host applications can share the same domain model and business rules, while still being free to implement their own persistence, UI, and integrations. Just slap the SDK into your project, implement the repository interfaces, and you have a fully-featured LMS backend ready to go.

## Documentation

Start at the [documentation index](./docs/INDEX.md). Every module has its own page
with its types, methods, permissions, events, known limitations and tests, and there are
dedicated pages for [permissions](./docs/PERMISSIONS.md), [tenancy](./docs/TENANCY.md),
[events](./docs/EVENTS.md) and [guardians](./docs/GUARDIANS.md). New to the SDK? Begin
with [Getting Started](./docs/GETTING_STARTED.md).

## Project layout (for contributors and plugin authors)

Source is organized into layers, each with its own `README.md` explaining
what belongs there:

| Layer | What goes here | Start with |
| --- | --- | --- |
| [`src/core/`](./src/core/README.md) | Shared types, repository interfaces, the `EventBus`, tenancy and permissions | `events.ts` |
| [`src/domains/`](./src/domains/README.md) | Modules that own a primary entity: enrollment, content, assessment, grading, delegation, scheduling | [`scheduling/README.md`](./src/domains/scheduling/README.md) |
| [`src/services/`](./src/services/README.md) | Cross-cutting modules that consume what domains produce: communication, reporting, admin | — |
| `src/interop/` | Pluggable protocol seams (LTI, SSO, SCORM/xAPI), no implementations | — |

**The one rule:** a module may import only `core` and its own files, never
another domain or service. Modules coordinate through the shared `EventBus`
instead. This is enforced by `test/architecture.test.ts`, so a change that
breaks it fails CI.

## Verifying a change

Run all three; each catches something the others cannot.

```sh
npx tsc --noEmit
npx tsc --noEmit --ignoreConfig test/*.test.ts src/domains/scheduling/index.ts \
  --moduleResolution nodenext --module nodenext --target es2022 --types bun-types \
  --strict --exactOptionalPropertyTypes --noUncheckedIndexedAccess \
  --verbatimModuleSyntax --skipLibCheck
bun test
```

`bun test` does not typecheck, which is why the second command exists: it typechecks the
tests under the same strict flags as the source. Changes to permissions or tenancy are
expected to come with tests written first and to be mutation-tested (break the code on
purpose and confirm a test fails). The docs under `docs/` are checked by
`test/docs.test.ts`, so a new built-in action, module or export that is not documented
fails the build.
