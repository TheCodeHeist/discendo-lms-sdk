import { describe, it, expect, afterEach, setSystemTime } from 'bun:test';
import { CalendarService } from '../src/domains/scheduling/calendar/index.js';

const NOW = new Date('2026-09-30T12:00:00Z');

afterEach(() => {
  setSystemTime(); // restore the real clock
});

describe('CalendarService.getAvailability', () => {
  const service = new CalendarService();
  const opensAt = new Date('2026-10-05T09:00:00Z');
  const closesAt = new Date('2026-10-12T09:00:00Z');

  it('is open when the window has no bounds at all', () => {
    expect(service.getAvailability({}, NOW)).toBe('open');
  });

  it('is locked before opensAt', () => {
    expect(service.getAvailability({ opensAt, closesAt }, new Date('2026-10-05T08:59:59.999Z'))).toBe('locked');
  });

  it('is open at exactly opensAt (the opening instant is inclusive)', () => {
    expect(service.getAvailability({ opensAt, closesAt }, opensAt)).toBe('open');
  });

  it('is open between opensAt and closesAt', () => {
    expect(service.getAvailability({ opensAt, closesAt }, new Date('2026-10-08T00:00:00Z'))).toBe('open');
  });

  it('is still open at exactly closesAt (the closing instant is inclusive)', () => {
    expect(service.getAvailability({ opensAt, closesAt }, closesAt)).toBe('open');
  });

  it('is closed one millisecond after closesAt', () => {
    expect(service.getAvailability({ opensAt, closesAt }, new Date(closesAt.getTime() + 1))).toBe('closed');
  });

  it('with only opensAt set: locked before, open forever after', () => {
    expect(service.getAvailability({ opensAt }, new Date('2026-10-01T00:00:00Z'))).toBe('locked');
    expect(service.getAvailability({ opensAt }, new Date('2099-01-01T00:00:00Z'))).toBe('open');
  });

  it('with only closesAt set: open from the beginning of time, closed after', () => {
    expect(service.getAvailability({ closesAt }, new Date('1999-01-01T00:00:00Z'))).toBe('open');
    expect(service.getAvailability({ closesAt }, new Date('2026-10-13T00:00:00Z'))).toBe('closed');
  });

  it('defaults `now` to the current time', () => {
    setSystemTime(new Date('2026-10-06T00:00:00Z'));
    expect(service.getAvailability({ opensAt, closesAt })).toBe('open');
    setSystemTime(new Date('2026-10-01T00:00:00Z'));
    expect(service.getAvailability({ opensAt, closesAt })).toBe('locked');
    setSystemTime(new Date('2026-10-20T00:00:00Z'));
    expect(service.getAvailability({ opensAt, closesAt })).toBe('closed');
  });

  it('compares real instants, so Dates built from different UTC offsets agree', () => {
    // 09:00 at UTC+06:00 is 03:00Z. The window opens at that instant no matter
    // which offset the host app used to construct the Date.
    const window = { opensAt: new Date('2026-10-05T09:00:00+06:00') };
    expect(service.getAvailability(window, new Date('2026-10-05T02:59:59Z'))).toBe('locked');
    expect(service.getAvailability(window, new Date('2026-10-05T03:00:00Z'))).toBe('open');
    expect(service.getAvailability(window, new Date('2026-10-04T22:00:00-05:00'))).toBe('open'); // = 03:00Z
  });
});

describe('CalendarService.toIcal', () => {
  const service = new CalendarService();
  const CRLF = '\r\n';
  /** Undoes folding (RFC 5545 section 3.1), then splits into logical lines, without the final empty one. */
  const logical = (text: string) => text.replace(/\r\n[ \t]/g, '').split(CRLF).slice(0, -1);

  function icalFor(events: Array<{ id: string; title: string; dueAt: Date }>): string {
    setSystemTime(NOW);
    return service.toIcal(events);
  }

  const one = (title: string, id = 'a1') => icalFor([{ id, title, dueAt: new Date('2026-10-05T10:00:00Z') }]);

  it('produces just the calendar shell for an empty list', () => {
    expect(icalFor([])).toBe(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//DiscendoLMS//discendo-sdk//EN', 'END:VCALENDAR'].join(CRLF) + CRLF);
  });

  it('renders one event with UID, DTSTAMP, DTSTART and SUMMARY', () => {
    const out = icalFor([{ id: 'a1', title: 'Essay 1', dueAt: new Date('2026-10-05T10:00:00Z') }]);
    expect(out).toBe(
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//DiscendoLMS//discendo-sdk//EN',
        'BEGIN:VEVENT',
        'UID:a1',
        'DTSTAMP:20260930T120000Z',
        'DTSTART:20261005T100000Z',
        'SUMMARY:Essay 1',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join(CRLF) + CRLF,
    );
  });

  it('keeps events in the order given', () => {
    const out = icalFor([
      { id: 'second-alphabetically', title: 'B', dueAt: new Date('2026-10-06T00:00:00Z') },
      { id: 'first-alphabetically', title: 'A', dueAt: new Date('2026-10-05T00:00:00Z') },
    ]);
    expect(out.indexOf('UID:second-alphabetically')).toBeLessThan(out.indexOf('UID:first-alphabetically'));
    expect(out.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(out.match(/END:VEVENT/g)).toHaveLength(2);
  });

  it('separates every line with CRLF and never a bare LF', () => {
    const out = icalFor([{ id: 'a1', title: 'Essay 1', dueAt: new Date('2026-10-05T10:00:00Z') }]);
    expect(out.replaceAll(CRLF, '')).not.toContain('\n');
    expect(out.replaceAll(CRLF, '')).not.toContain('\r');
  });

  it('zero-pads every date field and drops milliseconds', () => {
    const out = icalFor([{ id: 'a1', title: 'T', dueAt: new Date('2026-01-02T03:04:05.789Z') }]);
    expect(out).toContain('DTSTART:20260102T030405Z');
  });

  it('always writes UTC, converting from whatever offset the Date was built with', () => {
    // 23:30 at UTC-05:00 is 04:30Z the NEXT day.
    const out = icalFor([{ id: 'a1', title: 'T', dueAt: new Date('2026-10-05T23:30:00-05:00') }]);
    expect(out).toContain('DTSTART:20261006T043000Z');
  });

  it('stamps DTSTAMP with the time of export, not the due date', () => {
    const out = icalFor([{ id: 'a1', title: 'T', dueAt: new Date('2030-01-01T00:00:00Z') }]);
    expect(out).toContain('DTSTAMP:20260930T120000Z');
  });

  it('fails loudly on an invalid dueAt instead of emitting a garbage date', () => {
    expect(() => icalFor([{ id: 'a1', title: 'T', dueAt: new Date('not a date') }])).toThrow(RangeError);
  });

  describe('text escaping (RFC 5545 section 3.3.11)', () => {
    it('escapes commas and semicolons in the title', () => {
      expect(one('Quiz 1, part 2; final')).toContain('SUMMARY:Quiz 1\\, part 2\\; final');
    });

    it('escapes backslashes, and does so before the other escapes', () => {
      expect(one('C:\\temp, x')).toContain('SUMMARY:C:\\\\temp\\, x');
    });

    it('turns a newline in the title into a literal \\n instead of a new line', () => {
      const out = one('Line one\nLine two');
      expect(out).toContain('SUMMARY:Line one\\nLine two');
      expect(out.split(CRLF).filter((l) => l.startsWith('Line two'))).toEqual([]);
    });

    it('cannot be used to inject extra properties or events through the title', () => {
      const lines = logical(one('Quiz\r\nBEGIN:VEVENT\r\nUID:evil\r\nSUMMARY:pwned'));
      // The injected text may survive as escaped characters inside SUMMARY,
      // but it must not become lines of its own.
      expect(lines.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(1);
      expect(lines.filter((l) => l.startsWith('UID:'))).toEqual(['UID:a1']);
      expect(lines.filter((l) => l.startsWith('SUMMARY:'))).toHaveLength(1);
      expect(lines).toHaveLength(10); // shell (3) + VEVENT block (6) + END:VCALENDAR
    });

    it('cannot be used to inject lines through the id either', () => {
      const lines = logical(one('T', 'x\r\nBEGIN:VEVENT'));
      expect(lines.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(1);
      expect(lines).toHaveLength(10);
    });

    it('leaves ordinary text, including unicode, untouched', () => {
      expect(one('Übung 3: Résumé ✓')).toContain('SUMMARY:Übung 3: Résumé ✓');
    });
  });

  describe('line termination (RFC 5545 section 3.1)', () => {
    it('ends every line with CRLF, the last one included, and does not end with a blank line', () => {
      for (const out of [icalFor([]), one('Essay 1')]) {
        expect(out.endsWith(`END:VCALENDAR${CRLF}`)).toBe(true);
        expect(out.endsWith(CRLF + CRLF)).toBe(false);
      }
    });

    it('names this SDK in the PRODID', () => {
      expect(icalFor([])).toContain('PRODID:-//DiscendoLMS//discendo-sdk//EN');
      expect(icalFor([])).not.toContain('lms-sdk//EN');
    });
  });

  describe('line folding (RFC 5545 section 3.1)', () => {
    const octets = (text: string) => new TextEncoder().encode(text).length;
    const physical = (text: string) => text.split(CRLF).slice(0, -1);
    const strictDecode = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

    it('leaves a line of exactly 75 octets alone, and folds one octet more', () => {
      const exactly75 = 'a'.repeat(75 - 'SUMMARY:'.length);
      expect(physical(one(exactly75)).filter((l) => l.startsWith('SUMMARY:'))).toEqual([`SUMMARY:${exactly75}`]);
      const out = physical(one(exactly75 + 'b'));
      const at = out.findIndex((l) => l.startsWith('SUMMARY:'));
      expect(octets(out[at]!)).toBe(75);
      expect(out[at + 1]).toBe(' b');
    });

    it('folds a long line so that no line is longer than 75 octets, each continuation starting with one space', () => {
      const out = one('x'.repeat(300));
      for (const line of physical(out)) expect(octets(line)).toBeLessThanOrEqual(75);
      const summary = physical(out).filter((l, i, all) => l.startsWith('SUMMARY:') || (l.startsWith(' ') && all[i - 1] !== undefined));
      expect(summary.length).toBe(5); // 308 octets: 75 + 74 + 74 + 74 + 11
      expect(summary.slice(1).every((l) => l.startsWith(' ') && !l.startsWith('  '))).toBe(true);
    });

    it('unfolds back to exactly the original line', () => {
      const title = 'Midterm: ' + 'long title, with; every escape \\ ' .repeat(12);
      const unfolded = logical(one(title));
      expect(unfolded.find((l) => l.startsWith('SUMMARY:'))).toBe(
        `SUMMARY:${title.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,')}`,
      );
    });

    it('never splits a multi-byte character: three-byte text', () => {
      const title = '✓'.repeat(100);
      const out = one(title);
      for (const line of physical(out)) {
        expect(octets(line)).toBeLessThanOrEqual(75);
        strictDecode(new TextEncoder().encode(line)); // throws on a broken sequence
      }
      expect(logical(out).find((l) => l.startsWith('SUMMARY:'))).toBe(`SUMMARY:${title}`);
    });

    it('never splits a multi-byte character: four-byte text (a surrogate pair in JavaScript), wherever the fold falls', () => {
      for (const prefix of ['', 'a', 'ab', 'abc', 'abcd']) {
        const title = prefix + '😀'.repeat(60);
        const out = one(title);
        for (const line of physical(out)) {
          expect(octets(line)).toBeLessThanOrEqual(75);
          // a lone surrogate (half of a split pair) makes encodeURIComponent throw
          expect(() => encodeURIComponent(line), JSON.stringify(line)).not.toThrow();
        }
        expect(logical(out).find((l) => l.startsWith('SUMMARY:'))).toBe(`SUMMARY:${title}`);
      }
    });

    it('folds mixed text at the right octet, keeping a character that straddles the limit whole', () => {
      const title = 'ab' + 'é'.repeat(80); // two-byte letters, so the 75-octet limit can fall inside one
      const out = one(title);
      for (const line of physical(out)) expect(octets(line)).toBeLessThanOrEqual(75);
      expect(logical(out).find((l) => l.startsWith('SUMMARY:'))).toBe(`SUMMARY:${title}`);
    });

    it('folds any line, the UID included', () => {
      const out = one('T', 'id-'.repeat(40));
      for (const line of physical(out)) expect(octets(line)).toBeLessThanOrEqual(75);
      expect(logical(out).find((l) => l.startsWith('UID:'))).toBe(`UID:${'id-'.repeat(40)}`);
    });

    it('does not let a long title with line breaks inject lines, once unfolded', () => {
      const title = ('Quiz\r\nBEGIN:VEVENT\r\nUID:evil\r\n' + 'z'.repeat(120)).repeat(2);
      const lines = logical(one(title));
      expect(lines.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(1);
      expect(lines.filter((l) => l.startsWith('UID:'))).toEqual(['UID:a1']);
      expect(lines.filter((l) => l.startsWith('SUMMARY:'))).toHaveLength(1);
      expect(lines).toHaveLength(10);
    });

    it('does not fold short lines, so ordinary output is unchanged', () => {
      expect(physical(one('Essay 1')).every((l) => !l.startsWith(' '))).toBe(true);
    });
  });
});
