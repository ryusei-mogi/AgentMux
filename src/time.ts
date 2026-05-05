export function windowStart(window: string, now = Date.now()): number {
  if (/^\d+h$/.test(window)) {
    return now - Number(window.slice(0, -1)) * 60 * 60 * 1000;
  }
  const date = new Date(now);
  if (window === 'daily') {
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }
  if (window === 'weekly') {
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - date.getDay());
    return date.getTime();
  }
  if (window === 'monthly') {
    date.setHours(0, 0, 0, 0);
    date.setDate(1);
    return date.getTime();
  }
  throw new Error(`Unsupported window: ${window}`);
}

export function parseWindow(input: string, now = Date.now()): number {
  if (input === 'today') return windowStart('daily', now);
  if (/^\d+[hm]$/.test(input)) {
    const unit = input.at(-1);
    const value = Number(input.slice(0, -1));
    return now - value * (unit === 'h' ? 60 * 60 * 1000 : 60 * 1000);
  }
  return windowStart(input, now);
}
