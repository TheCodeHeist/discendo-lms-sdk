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

  function icalFor(events: Array<{ id: string; title: string; dueAt: Date }>): string {
    setSystemTime(NOW);
    return service.toIcal(events);
  }

  it('produces just the calendar shell for an empty list', () => {
    expect(icalFor([])).toBe(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//lms-sdk//EN', 'END:VCALENDAR', ''].join(CRLF));
  });

  it('renders one event with UID, DTSTAMP, DTSTART and SUMMARY', () => {
    const out = icalFor([{ id: 'a1', title: 'Essay 1', dueAt: new Date('2026-10-05T10:00:00Z') }]);
    expect(out).toBe(
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//lms-sdk//EN',
        'BEGIN:VEVENT',
        'UID:a1',
        'DTSTAMP:20260930T120000Z',
        'DTSTART:20261005T100000Z',
        'SUMMARY:Essay 1',
        'END:VEVENT',
        'END:VCALENDAR',
        '',
      ].join(CRLF),
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
    const one = (title: string, id = 'a1') =>
      icalFor([{ id, title, dueAt: new Date('2026-10-05T10:00:00Z') }]);

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
      const lines = one('Quiz\r\nBEGIN:VEVENT\r\nUID:evil\r\nSUMMARY:pwned').split(CRLF);
      // The injected text may survive as escaped characters inside SUMMARY,
      // but it must not become lines of its own.
      expect(lines.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(1);
      expect(lines.filter((l) => l.startsWith('UID:'))).toEqual(['UID:a1']);
      expect(lines.filter((l) => l.startsWith('SUMMARY:'))).toHaveLength(1);
      expect(lines).toHaveLength(11); // shell (3) + VEVENT block (6) + END:VCALENDAR + trailing empty string from trailing CRLF
    });

    it('cannot be used to inject lines through the id either', () => {
      const lines = one('T', 'x\r\nBEGIN:VEVENT').split(CRLF);
      expect(lines.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(1);
      expect(lines).toHaveLength(11);
    });

    it('leaves ordinary text, including unicode, untouched', () => {
      expect(one('Übung 3: Résumé ✓')).toContain('SUMMARY:Übung 3: Résumé ✓');
    });
  });

  it('folds content lines longer than 75 octets (RFC 5545 section 3.1)', () => {
    // Generate a long title that will force folding
    const longTitle = 'A'.repeat(80);
    const out = icalFor([{ id: 'a1', title: longTitle, dueAt: new Date('2026-10-05T10:00:00Z') }]);
    const lines = out.split(CRLF);

    // Summary line + 80 A's
    // SUMMARY: + 80 A's = 88 bytes
    // 88 bytes should be split into 75 bytes and 13 bytes
    const summaryLineIndex = lines.findIndex(l => l.startsWith('SUMMARY:'));
    expect(summaryLineIndex).toBeGreaterThan(-1);

    const firstLine = lines[summaryLineIndex];
    const secondLine = lines[summaryLineIndex + 1];

    // First line should be exactly 75 bytes
    expect(Buffer.byteLength(firstLine, 'utf8')).toBe(75);
    // Second line should start with a space
    expect(secondLine.startsWith(' ')).toBe(true);
    // Combined they should form the original line
    expect(firstLine + secondLine.substring(1)).toBe('SUMMARY:' + longTitle);
  });

  it('folds correctly with multi-byte unicode characters', () => {
    const uStr = "SUMMARY:Übung 3: Résumé ✓ Übung 3: Résumé ✓ Übung 3: Résumé ✓ Übung 3: Résumé ✓";
    const out = icalFor([{ id: 'a1', title: "Übung 3: Résumé ✓ Übung 3: Résumé ✓ Übung 3: Résumé ✓ Übung 3: Résumé ✓", dueAt: new Date('2026-10-05T10:00:00Z') }]);
    const lines = out.split(CRLF);
    const summaryLineIndex = lines.findIndex(l => l.startsWith('SUMMARY:'));

    const firstLine = lines[summaryLineIndex];
    const secondLine = lines[summaryLineIndex + 1];

    expect(Buffer.byteLength(firstLine, 'utf8')).toBeLessThanOrEqual(75);
    expect(secondLine.startsWith(' ')).toBe(true);
    expect(firstLine + secondLine.substring(1)).toBe(uStr);
  });

  it('terminates the final line (END:VCALENDAR) with CRLF like every other line', () => {
    const out = icalFor([]);
    expect(out.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });
});
