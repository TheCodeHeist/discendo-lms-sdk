/** The action exists but is not one an instructor may hand to a TA. */
export class ActionNotDelegableError extends Error {
  constructor(readonly action: string) {
    super(`Not delegable: ${action}`);
    this.name = 'ActionNotDelegableError';
  }
}

/** The person is not currently an active teaching assistant in the section. */
export class NotAnActiveTaError extends Error {
  constructor() {
    // Generic on purpose: the caller is already permitted in this section, but there is
    // no reason to say more about someone else's enrollment than "not an active TA".
    super('Not an active teaching assistant in this section');
    this.name = 'NotAnActiveTaError';
  }
}
