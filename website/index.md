---
layout: home

hero:
  name: Discendo SDK
  text: The LMS engine for your own stack
  tagline: Typed domain models, pure calculation functions and repository-driven services for enrollment, content, assessment, grading, scheduling and more. You choose the database and framework.
  image:
    src: /logo.svg
    alt: Discendo SDK
  actions:
    - theme: brand
      text: Get Started
      link: /introduction/what-is-discendo
    - theme: alt
      text: Build an LMS →
      link: /tutorial/
    - theme: alt
      text: View on GitHub
      link: https://github.com/TheCodeHeist/discendo-lms-sdk

features:
  - icon: 🗄️
    title: Bring your own database
    details: Every module defines repository interfaces. You implement them with Prisma, Drizzle, raw SQL or an in-memory Map. The SDK has no runtime dependencies.
    link: /concepts/repositories
    linkText: Repositories
  - icon: 🧩
    title: Adopt one module or all of them
    details: Modules import only core and their own files, never each other. You can use just grading, or the whole thing.
    link: /introduction/architecture
    linkText: Architecture
  - icon: 🔐
    title: Permissions that fail closed
    details: Optional role-based enforcement in every service. A missing actor, an unknown target or a policy that throws are all refused, and a refusal reveals nothing about the target.
    link: /concepts/permissions
    linkText: Permissions
  - icon: 🏛️
    title: Multi-tenant by design
    details: Organizations are a hard wall that nobody crosses, admins included. Departments sort courses inside an organization. Anything from one tutor to a whole university fits.
    link: /concepts/tenancy
    linkText: Tenancy
  - icon: 📡
    title: Event-driven
    details: A typed EventBus connects the modules. Subscribe to grade, enrollment and submission events, or bridge them straight to your notification sink.
    link: /concepts/events
    linkText: Events
  - icon: 📜
    title: Nothing is deleted
    details: Grades are superseded, enrollments dropped, classes cancelled and grants revoked, so you keep a full history and an audit trail by default.
    link: /concepts/design-principles
    linkText: Design principles
  - icon: 🗓️
    title: Timetable solver included
    details: Recurring class templates, conflict detection, availability windows, room matching, and an auto-scheduler that shows you a plan before it writes anything.
    link: /modules/scheduling/
    linkText: Scheduling
  - icon: 🧮
    title: Grading logic built in
    details: Weighted final grades, late penalties, letter grades, extensions and excusals, curves and GPA. All of it is available as pure functions you can preview before you commit.
    link: /modules/grading
    linkText: Grading
---

<div class="home-showcase">

::: warning Early development
Discendo SDK is at **v0.1.0**. Expect breaking changes and gaps in coverage, and don't use it in production yet.
:::

## Five lines to your first enrollment

```ts
import { createRolePolicy, EventBus } from 'discendo-sdk/core'
import { EnrollmentService } from 'discendo-sdk/enrollment'

const bus = new EventBus()
const enrollment = new EnrollmentService(repos, bus, { policy: createRolePolicy() })

await enrollment.enroll(
  { userId: 'stu-1', sectionId: 'sec-1', role: 'student' },
  { actorId: currentUser.id }, // you authenticate; the SDK authorizes
)
```

`repos` is your implementation of the SDK's repository interfaces, which the [tutorial](/tutorial/) builds step by step with **Bun + Hono + Drizzle**.

</div>
