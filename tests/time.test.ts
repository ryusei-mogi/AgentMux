import { describe, expect, it } from 'vitest';
import { parseWindow, windowStart } from '../src/time.js';

describe('time windows', () => {
  const now = new Date(2026, 4, 7, 13, 15, 30, 123).getTime();

  it('computes fixed hour windows', () => {
    expect(windowStart('6h', now)).toBe(now - 6 * 60 * 60 * 1000);
  });

  it('computes calendar windows in local time', () => {
    const daily = new Date(now);
    daily.setHours(0, 0, 0, 0);
    expect(windowStart('daily', now)).toBe(daily.getTime());

    const weekly = new Date(now);
    weekly.setHours(0, 0, 0, 0);
    weekly.setDate(weekly.getDate() - weekly.getDay());
    expect(windowStart('weekly', now)).toBe(weekly.getTime());

    const monthly = new Date(now);
    monthly.setHours(0, 0, 0, 0);
    monthly.setDate(1);
    expect(windowStart('monthly', now)).toBe(monthly.getTime());
  });

  it('parses named and relative windows', () => {
    expect(parseWindow('today', now)).toBe(windowStart('daily', now));
    expect(parseWindow('12h', now)).toBe(now - 12 * 60 * 60 * 1000);
    expect(parseWindow('45m', now)).toBe(now - 45 * 60 * 1000);
    expect(parseWindow('monthly', now)).toBe(windowStart('monthly', now));
  });

  it('rejects unsupported windows', () => {
    expect(() => windowStart('quarterly', now)).toThrow(/Unsupported window/);
    expect(() => parseWindow('nonsense', now)).toThrow(/Unsupported window/);
  });
});
