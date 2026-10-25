import { describe, expect, it } from 'vitest';
import { isValidReminderSendTime, reminderStepDueAt } from '../src/reminders';

describe('reminderStepDueAt', () => {
  // 2026-10-25(日) 10:00 JST = 2026-10-25T01:00:00Z
  const target = '2026-10-25T01:00:00.000Z';

  it('uses offset_minutes when send_time is not set', () => {
    const due = reminderStepDueAt(target, { offset_minutes: -60, offset_days: null, send_time: null });
    expect(new Date(due).toISOString()).toBe('2026-10-25T00:00:00.000Z');
  });

  it('sends at HH:MM JST, N days before the JST date of the target', () => {
    // 前日 18:00 JST = 2026-10-24T09:00:00Z
    const due = reminderStepDueAt(target, { offset_minutes: -1440, offset_days: 1, send_time: '18:00' });
    expect(new Date(due).toISOString()).toBe('2026-10-24T09:00:00.000Z');
  });

  it('uses the JST date even when the UTC date differs', () => {
    // 2026-10-25 08:00 JST = 2026-10-24T23:00:00Z。JST の日付は 25日 → 前日は 24日
    const due = reminderStepDueAt('2026-10-24T23:00:00.000Z', { offset_minutes: 0, offset_days: 1, send_time: '18:00' });
    expect(new Date(due).toISOString()).toBe('2026-10-24T09:00:00.000Z');
  });

  it('treats a missing offset_days as the same day', () => {
    const due = reminderStepDueAt(target, { offset_minutes: 0, offset_days: null, send_time: '08:30' });
    expect(new Date(due).toISOString()).toBe('2026-10-24T23:30:00.000Z');
  });

  it('falls back to offset_minutes when send_time is malformed', () => {
    const due = reminderStepDueAt(target, { offset_minutes: 30, offset_days: 1, send_time: '25:00' });
    expect(new Date(due).toISOString()).toBe('2026-10-25T01:30:00.000Z');
  });
});

describe('isValidReminderSendTime', () => {
  it('accepts HH:MM', () => {
    expect(isValidReminderSendTime('00:00')).toBe(true);
    expect(isValidReminderSendTime('23:59')).toBe(true);
  });
  it('rejects others', () => {
    for (const v of ['24:00', '9:00', '18:60', '', null, 1800]) expect(isValidReminderSendTime(v)).toBe(false);
  });
});
