# Interop

`src/interop/` — the places where the SDK plugs into the outside world: LTI tool
launches and grade passback, single sign-on, and content-package import. Subpath:
`discendo-sdk/interop`.

**These are seams, not implementations.** The module contains interfaces and types and
no code that does anything. That is deliberate: LTI, SAML and OIDC are security-critical
protocols that should never be hand-rolled. The value the SDK adds is defining *where*
they plug into enrollment and grading; the protocols themselves belong to a maintained
library (for example `ltijs`, `openid-client` or `node-saml`).

## At a glance

| | |
| --- | --- |
| **You import** | the types only |
| **You implement** | whichever of the four interfaces below you need, using a real library |
| **Emits events** | none |
| **Permission actions** | none |

## The interfaces

### `LtiLaunchHandler`

```ts
interface LtiLaunchContext {
  issuer: string;
  clientId: string;
  deploymentId: string;
  userExternalRef: string;        // the person, as the platform names them
  contextExternalRef: string;     // maps to a CourseSection
  roles: string[];
}

interface LtiLaunchHandler {
  handleLaunch(context: LtiLaunchContext): Promise<{ sectionId: string; userId: string }>;
}
```

Called when an external platform launches your tool for a person. You verify the launch
with your LTI library, and `handleLaunch` maps the platform's references to a section and
a user in your system. A natural implementation uses
`UserRepository.findByExternalRef` and then
`EnrollmentService.enroll` ([ENROLLMENT.md](./ENROLLMENT.md)).

### `LtiGradePassback`

```ts
interface LtiGradePassback {
  sendGrade(lineItemId: string, userId: string, score: number, maxScore: number): Promise<void>;
}
```

Sends a grade back to the launching platform. Wire it to the `grading.gradePosted` event
([EVENTS.md](./EVENTS.md)) to pass grades back as they are recorded.

### `AuthProvider`

```ts
interface AuthProvider {
  verifyToken(token: string): Promise<{ externalRef: string; claims: Record<string, unknown> }>;
}
```

Verifies a token with whatever OIDC or SAML library you use and returns the person's
`externalRef` and claims. Look the person up with `UserRepository.findByExternalRef` to get
the `actorId` the SDK's enforcing services need. **This is where authentication happens**;
the SDK never does it ([PERMISSIONS.md](./PERMISSIONS.md)).

### `ContentPackageImporter`

```ts
interface ContentPackageImporter {
  importPackage(fileRef: string, sectionId: string): Promise<{ importedNodeIds: string[] }>;
}
```

Imports a SCORM or xAPI package into a section. Parsing is delegated to your chosen parser,
which creates content nodes (for example with `ContentService.createNode`) and reports their
ids.

## Known limitations

- **No implementations**, by design.
- **Nothing in the SDK calls these interfaces.** They are contracts for your own wiring; no
  service takes an `LtiLaunchHandler` or an `AuthProvider`.
- **Organization is not part of the contract.** `LtiLaunchContext` has an `issuer`, but nothing
  maps it to an `orgId`; a multi-organization host does that itself.
- **No tests**, since there is no code.
