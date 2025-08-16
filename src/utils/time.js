import { DateTime } from 'luxon';

export function nowUtc() {
  return DateTime.utc();
}

export function parseServerHHmmToUtcToday(hhmm) {
  // Returns a UTC DateTime for *today* at provided HH:mm (server time is UTC)
  const [H, M] = hhmm.split(':').map(Number);
  if (Number.isNaN(H) || Number.isNaN(M) || H < 0 || H > 23 || M < 0 || M > 59) return null;
  return DateTime.utc().set({ hour: H, minute: M, second: 0, millisecond: 0 });
}

// Explicit UTC string for Server Time
export function fmtUtc(dtUtc) {
  return dtUtc.setZone('utc').toFormat("yyyy-LL-dd HH:mm 'UTC'");
}

// Discord timestamp tag helpers (<t:UNIX:format>)
export function toUnixSeconds(dtUtc) {
  return Math.floor(dtUtc.toSeconds());
}