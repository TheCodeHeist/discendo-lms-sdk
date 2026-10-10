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

  /**
   * Minimal iCal (RFC 5545) export for a set of due dates. Lines longer than 75 octets are folded
   * (CRLF plus one space, never inside a multi-byte character), and every line, the last one
   * included, ends with CRLF.
   */
  toIcal(events: Array<{ id: string; title: string; dueAt: Date }>): string {
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//DiscendoLMS//discendo-sdk//EN'];
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
    return lines.map(foldLine).join('\r\n') + '\r\n';
  }
}

const MAX_LINE_OCTETS = 75;

/**
 * Folds one content line per RFC 5545 section 3.1: no physical line longer than 75 octets
 * (excluding the line break), each continuation starting with a single space that counts toward
 * its 75. The limit is in octets, so a character is only ever moved whole to the next line:
 * counting JavaScript characters would split multi-byte text, and a split UTF-8 sequence is
 * garbage once the feed is read.
 */
function foldLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= MAX_LINE_OCTETS) return line;
  const physical: string[] = [];
  let current = '';
  let currentOctets = 0;
  for (const char of line) {
    // iterating by code point keeps a surrogate pair (a four-octet character) together
    const octets = encoder.encode(char).length;
    if (currentOctets + octets > MAX_LINE_OCTETS) {
      physical.push(current);
      current = ' ';
      currentOctets = 1;
    }
    current += char;
    currentOctets += octets;
  }
  physical.push(current);
  return physical.join('\r\n');
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
