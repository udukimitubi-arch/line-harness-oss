// 日本の祝日（国民の祝日に関する法律。2022年以降のきまり）を計算で求める。
// 外部のカレンダーに頼らないので、Google 連携が切れていても使える。
// 春分・秋分の日は、国立天文台の暦要項と一致する近似式（1980〜2099年）で求める。

const FIXED: Array<[number, number]> = [
  [1, 1], // 元日
  [2, 11], // 建国記念の日
  [2, 23], // 天皇誕生日
  [4, 29], // 昭和の日
  [5, 3], // 憲法記念日
  [5, 4], // みどりの日
  [5, 5], // こどもの日
  [8, 11], // 山の日
  [11, 3], // 文化の日
  [11, 23], // 勤労感謝の日
];

// [月, 第何月曜]
const HAPPY_MONDAYS: Array<[number, number]> = [
  [1, 2], // 成人の日
  [7, 3], // 海の日
  [9, 3], // 敬老の日
  [10, 2], // スポーツの日
];

function ymd(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function weekday(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function nthMonday(year: number, month: number, n: number): number {
  const first = weekday(year, month, 1);
  const firstMonday = 1 + ((8 - first) % 7);
  return firstMonday + (n - 1) * 7;
}

function equinoxDay(year: number, base: number): number {
  const y = year - 1980;
  return Math.floor(base + 0.242194 * y - Math.floor(y / 4));
}

const cache = new Map<number, Set<string>>();

/** その年の祝日（振替休日・国民の休日を含む）を 'YYYY-MM-DD' の集合で返す。 */
export function japaneseHolidays(year: number): Set<string> {
  const hit = cache.get(year);
  if (hit) return hit;
  const days = new Set<string>();
  for (const [m, d] of FIXED) days.add(ymd(year, m, d));
  for (const [m, n] of HAPPY_MONDAYS) days.add(ymd(year, m, nthMonday(year, m, n)));
  if (year >= 1980 && year <= 2099) {
    days.add(ymd(year, 3, equinoxDay(year, 20.8431))); // 春分の日
    days.add(ymd(year, 9, equinoxDay(year, 23.2488))); // 秋分の日
  }

  const sorted = [...days].sort();
  // 国民の休日: 祝日にはさまれた平日（例: 9月の敬老の日と秋分の日の間）
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = new Date(`${sorted[i]}T00:00:00Z`).getTime();
    const b = new Date(`${sorted[i + 1]}T00:00:00Z`).getTime();
    if (b - a === 2 * 86400_000) {
      const mid = new Date(a + 86400_000);
      if (mid.getUTCDay() !== 0) days.add(mid.toISOString().slice(0, 10));
    }
  }
  // 振替休日: 日曜の祝日のあと、最初の祝日でない日
  for (const day of [...days].sort()) {
    const t = new Date(`${day}T00:00:00Z`);
    if (t.getUTCDay() !== 0) continue;
    let next = new Date(t.getTime() + 86400_000);
    while (days.has(next.toISOString().slice(0, 10))) next = new Date(next.getTime() + 86400_000);
    days.add(next.toISOString().slice(0, 10));
  }
  cache.set(year, days);
  return days;
}

/** 'YYYY-MM-DD' が日本の祝日か。 */
export function isJapaneseHoliday(date: string): boolean {
  const year = Number(date.slice(0, 4));
  if (!Number.isInteger(year)) return false;
  return japaneseHolidays(year).has(date);
}
