import type { DefaultTheme } from 'vitepress'

/**
 * Single source of truth for the site's navigation tree.
 * Every link here must resolve to a page under `website/`.
 */

export const introduction: DefaultTheme.SidebarItem[] = [
  {
    text: 'Introduction',
    items: [
      { text: 'What is Discendo?', link: '/introduction/what-is-discendo' },
      { text: 'Quick Start', link: '/introduction/quick-start' },
      { text: 'Architecture', link: '/introduction/architecture' },
    ],
  },
]

export const concepts: DefaultTheme.SidebarItem[] = [
  {
    text: 'Core Concepts',
    items: [
      { text: 'Design Principles', link: '/concepts/design-principles' },
      { text: 'Repositories', link: '/concepts/repositories' },
      { text: 'Services & Wiring', link: '/concepts/services' },
      { text: 'Events', link: '/concepts/events' },
      { text: 'Permissions', link: '/concepts/permissions' },
      { text: 'Tenancy', link: '/concepts/tenancy' },
    ],
  },
]

export const modules: DefaultTheme.SidebarItem[] = [
  {
    text: 'Module Reference',
    items: [
      { text: 'Overview', link: '/modules/' },
      { text: 'Core', link: '/modules/core' },
    ],
  },
  {
    text: 'Domains',
    items: [
      { text: 'Enrollment', link: '/modules/enrollment' },
      { text: 'Content', link: '/modules/content' },
      { text: 'Assessment', link: '/modules/assessment' },
      { text: 'Grading', link: '/modules/grading' },
      { text: 'Delegation', link: '/modules/delegation' },
      { text: 'Guardians', link: '/modules/guardians' },
      {
        text: 'Scheduling',
        collapsed: true,
        items: [
          { text: 'Overview', link: '/modules/scheduling/' },
          { text: 'Templates & Occurrences', link: '/modules/scheduling/templates-occurrences' },
          { text: 'Conflicts & Availability', link: '/modules/scheduling/conflicts-availability' },
          { text: 'Rooms & Groups', link: '/modules/scheduling/rooms-groups' },
          { text: 'Auto-Scheduling Solver', link: '/modules/scheduling/solver' },
          { text: 'Calendar & iCal', link: '/modules/scheduling/calendar' },
        ],
      },
    ],
  },
  {
    text: 'Services',
    items: [
      { text: 'Communication', link: '/modules/communication' },
      { text: 'Reporting', link: '/modules/reporting' },
      { text: 'Admin & Audit', link: '/modules/admin' },
    ],
  },
  {
    text: 'Interop',
    items: [{ text: 'LTI, SSO & SCORM Seams', link: '/modules/interop' }],
  },
]

export const tutorial: DefaultTheme.SidebarItem[] = [
  {
    text: 'Build an LMS',
    items: [
      { text: 'Overview', link: '/tutorial/' },
      { text: '1. Project Setup', link: '/tutorial/01-project-setup' },
      { text: '2. Database Schema', link: '/tutorial/02-database-schema' },
      { text: '3. Implementing Repositories', link: '/tutorial/03-repositories' },
      { text: '4. Wiring Services', link: '/tutorial/04-wiring-services' },
    ],
  },
  {
    text: 'People & Access',
    items: [
      { text: '5. Authentication & Actors', link: '/tutorial/05-authentication' },
      { text: '6. Roles & Permissions', link: '/tutorial/06-permissions' },
      { text: '7. Organizations & Departments', link: '/tutorial/07-organizations' },
    ],
  },
  {
    text: 'Teaching & Learning',
    items: [
      { text: '8. Courses, Terms & Sections', link: '/tutorial/08-courses' },
      { text: '9. Enrollment & Waitlists', link: '/tutorial/09-enrollment' },
      { text: '10. Course Content', link: '/tutorial/10-content' },
      { text: '11. Assignments & Quizzes', link: '/tutorial/11-assessment' },
      { text: '12. Grading & Gradebook', link: '/tutorial/12-grading' },
    ],
  },
  {
    text: 'Operations',
    items: [
      { text: '13. Timetables', link: '/tutorial/13-timetables' },
      { text: '14. Announcements & Notifications', link: '/tutorial/14-notifications' },
      { text: '15. Attendance & Reports', link: '/tutorial/15-reports' },
      { text: '16. Audit Log', link: '/tutorial/16-audit-log' },
      { text: '17. Parent Portal (Guardians)', link: '/tutorial/17-guardians' },
    ],
  },
  {
    text: 'Shipping',
    items: [
      { text: '18. Testing', link: '/tutorial/18-testing' },
      { text: '19. Deployment', link: '/tutorial/19-deployment' },
    ],
  },
]

export const sidebar: DefaultTheme.Sidebar = {
  '/introduction/': [...introduction, ...concepts],
  '/concepts/': [...introduction, ...concepts],
  '/modules/': modules,
  '/tutorial/': tutorial,
}
