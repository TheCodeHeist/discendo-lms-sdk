---
description: Learn about the type-only seams for LTI 1.3, SAML/OIDC SSO, and SCORM/xAPI content packages in discendo-sdk/interop.
---

# Interop

`discendo-sdk/interop` defines standardized, type-only seams for integrating external educational protocols: LTI 1.3 tool launches, grade passback, Single Sign-On (SSO), and SCORM/xAPI content package imports.

::: important Seams, Not Implementations
This module contains **TypeScript interfaces and zero runtime code**. Protocols like SAML, OIDC, and LTI 1.3 are complex, security-critical standards that should be implemented using maintained third-party libraries (e.g. `ltijs`, `node-saml`, `openid-client`). The SDK defines _where_ these libraries connect to your LMS.
:::

---

## At a Glance

|                  |                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Import**       | `import type { LtiLaunchHandler, LtiGradePassback, AuthProvider, ContentPackageImporter } from 'discendo-sdk/interop'` |
| **Runtime Code** | None (pure interface contracts)                                                                                        |
| **Events**       | None                                                                                                                   |
| **Permissions**  | None                                                                                                                   |

---

## 1. LTI 1.3 Tool Launch (`LtiLaunchHandler`)

Handles incoming launches from an external LMS (Canvas, Blackboard, Moodle) when your system acts as an LTI tool:

```ts
interface LtiLaunchContext {
  issuer: string;
  clientId: string;
  deploymentId: string;
  userExternalRef: string; // Student/instructor external ID
  contextExternalRef: string; // Maps to CourseSection
  roles: string[];
}

interface LtiLaunchHandler {
  handleLaunch(context: LtiLaunchContext): Promise<{
    sectionId: string;
    userId: string;
  }>;
}
```

### Wiring Example:

Your application verifies the LTI 1.3 JWT using a library like `ltijs`, then executes `handleLaunch()`:

```ts
class MyLtiLaunchHandler implements LtiLaunchHandler {
  async handleLaunch(ctx: LtiLaunchContext) {
    // 1. Resolve or create user via externalRef
    let user = await userRepo.findByExternalRef(ctx.userExternalRef);
    if (!user) {
      user = await userRepo.create({
        externalRef: ctx.userExternalRef,
        roles: ["student"],
      });
    }

    // 2. Resolve or create course section
    const section = await courseRepo.findByExternalRef(ctx.contextExternalRef);

    // 3. Auto-enroll user if not enrolled
    await enrollmentService.enroll({
      userId: user.id,
      sectionId: section.id,
      role: ctx.roles.includes("Instructor") ? "instructor" : "student",
    });

    return { sectionId: section.id, userId: user.id };
  }
}
```

---

## 2. LTI Grade Passback (`LtiGradePassback`)

Transfers student grades back to the upstream LMS platform:

```ts
interface LtiGradePassback {
  sendGrade(
    lineItemId: string,
    userId: string,
    score: number,
    maxScore: number,
  ): Promise<void>;
}
```

### Automatic Sync via EventBus:

Connect this seam directly to `grading.gradePosted` events:

```ts
bus.on("grading.gradePosted", async (event) => {
  const lineItem = await db.lineItems.findByContentId(event.contentId);
  if (lineItem) {
    await ltiPassback.sendGrade(
      lineItem.id,
      event.userId,
      event.score,
      event.maxScore,
    );
  }
});
```

---

## 3. SSO Authentication Seam (`AuthProvider`)

Validates tokens from SAML 2.0 or OIDC Identity Providers:

```ts
interface AuthProvider {
  verifyToken(token: string): Promise<{
    externalRef: string;
    claims: Record<string, unknown>;
  }>;
}
```

This is where authentication occurs. Once verified, look up the user using `userRepo.findByExternalRef()` to obtain the `{ actorId }` required by the SDK's enforcing services.

---

## 4. SCORM & xAPI Packages (`ContentPackageImporter`)

Ingests interactive e-learning zip packages (SCORM 1.2, SCORM 2004, or xAPI/cmi5):

```ts
interface ContentPackageImporter {
  importPackage(
    fileRef: string,
    sectionId: string,
  ): Promise<{ importedNodeIds: string[] }>;
}
```

Your parser unzips the manifest (`imsmanifest.xml`), creates the corresponding `ContentNode` tree via `contentService.createNode()`, and returns the newly generated IDs.
