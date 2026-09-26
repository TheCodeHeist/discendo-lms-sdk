/**
 * These are seams, not implementations. Don't hand-roll LTI/SAML/OIDC —
 * expose the interface here and let the host app plug in a real library
 * (e.g. ltijs, openid-client, node-saml). The value the SDK adds is
 * defining *where* these plug into enrollment/grading, not the protocols.
 */

export interface LtiLaunchContext {
  issuer: string;
  clientId: string;
  deploymentId: string;
  userExternalRef: string;
  contextExternalRef: string; // maps to a CourseSection
  roles: string[];
}

export interface LtiLaunchHandler {
  handleLaunch(context: LtiLaunchContext): Promise<{ sectionId: string; userId: string }>;
}

export interface LtiGradePassback {
  sendGrade(lineItemId: string, userId: string, score: number, maxScore: number): Promise<void>;
}

export interface AuthProvider {
  /** Host app implements against whatever OIDC/SAML library it uses. */
  verifyToken(token: string): Promise<{ externalRef: string; claims: Record<string, unknown> }>;
}

export interface ContentPackageImporter {
  /** SCORM/xAPI package import — parsing is delegated to the host's chosen parser. */
  importPackage(fileRef: string, sectionId: string): Promise<{ importedNodeIds: string[] }>;
}
