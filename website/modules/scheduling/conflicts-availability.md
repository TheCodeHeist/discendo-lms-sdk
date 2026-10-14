---
description: Learn how discendo-sdk/scheduling prevents double-bookings, evaluates working hours availability, and validates bookings with checkAll.
---

# Conflicts & Availability

The scheduling module separates **double-booking detection** (is this resource already scheduled elsewhere?) from **availability rules** (is this resource declared open for bookings at this time?).

A teacher can be available according to their contract but double-booked, or completely unbooked but outside their declared working hours. Discendo evaluates both constraints independently.

---

## Double-Booking Conflict Detection

The SDK includes pure conflict detection algorithms (`rules/conflict.ts`) that operate over occurrence collections:

### Types of Conflicts:

1. **Teacher Conflict:** An instructor is assigned to two overlapping occurrences at the same time.
2. **Room Conflict:** A physical classroom is assigned to two concurrent meetings.
3. **Group Conflict:** A student cohort is scheduled for two classes simultaneously.

```ts
import { findConflicts } from "discendo-sdk/scheduling";

// Pure function: returns any overlapping pairs
const conflicts = findConflicts(existingOccurrences, candidateOccurrence);
if (conflicts.length > 0) {
  console.warn("Double-booking detected:", conflicts);
}
```

---

## Availability Rules (`AvailabilityRule`)

An `AvailabilityRule` specifies when a resource is permitted to be booked:

```ts
interface AvailabilityRule {
  id: string;
  resourceId: string;
  resourceType: "teacher" | "room" | "group";
  rule: RecurrenceRule; // e.g. Weekly M-F
  startTime: string; // "09:00"
  endTime: string; // "17:00"
  timezone: string;
  validFrom: Date;
  validUntil?: Date;
}
```

### Opt-In Availability:

If no `AvailabilityRule` is seeded for a resource, the resource is treated as **unconstrained** (available at all times). You only define availability rules for resources with specific constraints (e.g. adjunct faculty who teach only on Tuesdays and Thursdays).

---

## Comprehensive Validation: `checkAll`

When building a manual timetable scheduling UI, you should validate candidate bookings against all constraints before persisting them to the database:

```ts
const check = await schedulingService.checkAll(
  candidateOccurrence,
  {
    teacherIds: ["u-prof-jane"],
    roomId: "room-lab-201",
    groupId: "cohort-2026-cs",
    startTime: "10:00",
    endTime: "10:50",
  },
  {
    minCapacity: 28,
    requiredFeatures: ["lab", "projector"],
  },
  { actorId: "u-admin" },
);

if (!check.ok) {
  // Inspect failure reasons
  console.log(check.conflicts); // Double-bookings
  console.log(check.availabilityViolations); // Outside declared hours
  console.log(check.roomViolation); // Capacity or feature mismatch
}
```

### What `checkAll` Evaluates:

1. **No teacher double-bookings** across all specified instructors.
2. **No room double-booking** for the designated classroom.
3. **No group double-booking** for the student cohort.
4. **Teacher availability rules** (within declared working hours).
5. **Room availability rules** (within building operating hours).
6. **Group availability rules** (within cohort study windows).
7. **Room capacity** (`room.capacity >= minCapacity`).
8. **Room features** (`room.features` contains all `requiredFeatures`).
9. **Teacher qualifications** (if qualification rules are enabled).

---

## Known Limitations

- **Interval > 1 availability limitation:** The auto-scheduling solver supports availability rules with `interval: 1` (weekly). Bi-weekly or rotating monthly availability rules are flagged in `skippedAvailability` during solver planning.
