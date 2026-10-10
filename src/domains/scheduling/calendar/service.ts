export type AvailabilityState = 'locked' | 'open' | 'closed';

export interface AvailabilityWindow {
  opensAt?: Date; // undefined = always open (no lower bound)
  closesAt?: Date; // undefined = never closes
}

/**
 * All timestamps in/out of this module are UTC. Converting to the viewer's
 * local timezone is a presentation-layer concern — do it at the edge in the
 * host app, never inside SDK logic, or you WILL get off-by-one-timezone bugs.
 */
export class CalendarService {
  getAvailability(window: AvailabilityWindow, now: Date = new Date()): AvailabilityState {
    if (window.opensAt && now < window.opensAt) return 'locked';
    if (window.closesAt && now > window.closesAt) return 'closed';
    return 'open';
  }

  /** Minimal iCal (RFC 5545) export for a set of due dates. */
  toIcal(events: Array<{ id: string; title: string; dueAt: Date }>): string {
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//lms-sdk//EN'];
    for (const e of events) {
      lines.push(
        'BEGIN:VEVENT',
        `UID:${escapeIcalText(e.id)}`,
        `DTSTAMP:${formatIcalDate(new Date())}`,
        `DTSTART:${formatIcalDate(e.dueAt)}`,
        `SUMMARY:${escapeIcalText(e.title)}`,
        'END:VEVENT',
      );
    }
    lines.push('END:VCALENDAR');
    return lines.map(foldIcalLine).join('\r\n') + '\r\n';
  }
}

/**
 * Folds lines longer than 75 octets per RFC 5545 section 3.1.
 * Folding is done by inserting CRLF + SPACE, and the line break
 * can occur between any two characters.
 */
function foldIcalLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;

  let folded = '';
  let currentLineBytes = 0;

  for (const char of line) {
    const charBytes = encoder.encode(char).length;
    if (currentLineBytes + charBytes > 75) {
      folded += '\r\n ';
      currentLineBytes = 1;
    }
    folded += char;
    currentLineBytes += charBytes;
  }

  return folded;
}

function formatIcalDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

/**
 * Escapes a TEXT value per RFC 5545 section 3.3.11. Backslash must be
 * handled first so the backslashes added by the later replacements aren't
 * themselves doubled. Line breaks become a literal `\n`; without that, a
 * title containing CR/LF could start a new content line and inject
 * properties or whole events into a feed that other people subscribe to.
 */
function escapeIcalText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}
