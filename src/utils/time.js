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

export function fmtBothZones(dtUtc, userTz) {
  const server = dtUtc.setZone('utc').toFormat("yyyy-LL-dd HH:mm 'UTC'");
  const local = dtUtc.setZone(userTz).toFormat("yyyy-LL-dd HH:mm ZZZZ");
  return { server, local };
}

export function fmtWindowBoth(window, userTz) {
  const start = fmtBothZones(window.start, userTz);
  const end = fmtBothZones(window.end, userTz);
  return { start, end };
}