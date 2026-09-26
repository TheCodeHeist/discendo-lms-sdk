# HyperLMS SDK | A framework-agnostic SDK for any Learning Management System (LMS)

> **STILL IN EARLY DEVELOPMENT — expect breaking changes and incomplete coverage. The SDK is not yet ready for production use.**

A framework- and database-agnostic TypeScript SDK of LMS (Learning Management System) logic, built on Bun. The SDK provides typed domain models, pure calculation functions, and repository-interface-driven services for the core concerns of a learning platform — from a single-tutor setup to a multi-department university.

It never assumes a specific database, ORM, web framework, or UI: every module exposes interfaces the host application implements against whatever stack it already uses.

This SDK aims to standardize the core LMS logic so that different host applications can share the same domain model and business rules, while still being free to implement their own persistence, UI, and integrations. Just slap the SDK into your project, implement the repository interfaces, and you have a fully-featured LMS backend ready to go.

## Documentation

Check out the [documentation markdown file](./docs/INDEX.md) for a detailed overview of the SDK's modules, domain models, and services.
