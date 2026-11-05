/**
 * Grade release ("posting"): with a `GradeReleaseRepository` given to `GradingService`, a grade is
 * held from the student (and their guardians) until staff release the grades of that piece of
 * content for the section. Staff always see every grade. Without the repository every grade is
 * visible as soon as it is recorded, which is how the SDK has always behaved.
 */

/**
 * The grades of one piece of content released to the students of one section. Never deleted:
 * hiding them again sets `hiddenAt`, and releasing again creates a new record, so the history of
 * who showed and hid what, and when, is kept.
 */
export interface GradeRelease {
  id: string;
  sectionId: string;
  contentId: string;
  releasedAt: Date;
  releasedBy: string;
  hiddenAt?: Date;
  hiddenBy?: string;
}

export interface GradeReleaseRepository {
  create(release: Omit<GradeRelease, 'id'>): Promise<GradeRelease>;
  /** The release of this content in this section that has not been hidden, or null. There should never be two. */
  findActive(sectionId: string, contentId: string): Promise<GradeRelease | null>;
  /** Every release in the section that has not been hidden. */
  listActive(sectionId: string): Promise<GradeRelease[]>;
  /** Sets `hiddenAt` and `hiddenBy`, keeping the record. */
  hide(id: string, at: Date, by: string): Promise<GradeRelease>;
}

/** One current grade as `GradingService.listGradesForUser` shows it. */
export interface GradeView {
  entryId: string;
  submissionId: string;
  contentId?: string;
  category: string;
  score: number;
  maxScore: number;
  /** `score / maxScore` as a percentage. */
  percent: number;
  graderId: string;
  gradedAt: Date;
  /** Whether the student can see it. Always true when grades are not held (no release repository). */
  released: boolean;
  /** Excused work: it is listed, but left out of the final grade. */
  excused: boolean;
}
