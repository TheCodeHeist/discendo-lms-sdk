/** A guardian link's two people do not both exist in the actor's organization. */
export class GuardianLinkTargetError extends Error {
  constructor() {
    // The same message for "no such person" and "a person in another organization", so an admin
    // cannot use it to find out who exists in an organization that is not theirs.
    super('Guardian or ward not found in this organization');
    this.name = 'GuardianLinkTargetError';
  }
}

/** No such link in the actor's organization (or it does not exist: the two are not told apart). */
export class GuardianLinkNotFoundError extends Error {
  constructor() {
    super('Guardian link not found');
    this.name = 'GuardianLinkNotFoundError';
  }
}

/** There is already an active link from this guardian to this ward. */
export class GuardianLinkExistsError extends Error {
  constructor(readonly linkId: string) {
    super('An active link between this guardian and ward already exists');
    this.name = 'GuardianLinkExistsError';
  }
}

/** The request itself is not a valid link: a self-link, no scopes, an unknown scope, a revoked link. */
export class InvalidGuardianLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidGuardianLinkError';
  }
}

/** One guardian to notify, with the wards of theirs that are in the section. */
export interface GuardianRecipient {
  guardianId: string;
  wardIds: string[];
}
