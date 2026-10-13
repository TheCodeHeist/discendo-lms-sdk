---
description: Learn how discendo-sdk/scheduling manages physical rooms, equipment features, student cohort groups, and teacher qualifications.
---

# Rooms & Groups

Timetable scheduling must respect physical infrastructure and student groupings: rooms have capacity limits and specialized features (e.g., chemical hoods, computer workstations), while students belong to cohorts that take classes together.

---

## Rooms (`Room`)

```ts
interface Room {
  id: string;
  name: string;
  capacity: number;
  features: string[]; // e.g. ['lab', 'chemistry', 'projector', 'recording']
  orgId?: string; // Multi-tenant isolation
}
```

### Seeding Rooms in Repository

```ts
await schedulingRepo.createRoom({
  name: "Science Building Lab 101",
  capacity: 32,
  features: ["lab", "chemistry", "hoods"],
});
```

---

## Pure Room Matching (`matchRoom`)

Before assigning a room to a class template or occurrence, Discendo evaluates room compatibility using pure logic (`rules/room-matching.ts`):

```ts
import { matchRoom } from "discendo-sdk/scheduling";

const result = matchRoom(room, {
  minCapacity: 28,
  requiredFeatures: ["lab"],
});

if (!result.ok) {
  console.error(`Room incompatible: ${result.reason}`);
  // 'INSUFFICIENT_CAPACITY' | 'MISSING_FEATURES'
}
```

### Match Rules:

1. **Capacity Guarantee:** `room.capacity >= minCapacity`.
2. **Feature Containment:** The room's features array must be a superset of all requested features (`requiredFeatures.every(f => room.features.includes(f))`).

---

## Student Cohorts (`SchedulingGroup`)

A student cohort or section subdivision that moves through a timetable together:

```ts
interface SchedulingGroup {
  id: string;
  sectionId: string;
  name: string;
  size: number;
}
```

- When an auto-scheduler places a template with a `groupId`, it verifies that the assigned room has `capacity >= group.size`.
- The group cannot be scheduled for two overlapping occurrences (preventing timetable clashes for the students in that cohort).

---

## Teacher Qualifications

Institutions can optionally enforce that instructors only teach courses they are certified to lead:

```ts
interface TeacherQualification {
  teacherId: string;
  courseId: string;
}
```

When qualification checking is enabled, `checkAll` and the auto-scheduler verify that every assigned teacher holds a valid qualification record for the course being taught.

---

## Next Steps

- See how rooms, groups, and templates are combined to generate optimal timetables in the [Auto-Scheduling Solver](/modules/scheduling/solver).
