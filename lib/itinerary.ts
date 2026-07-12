type BudgetLevel = "budget" | "mid" | "premium";
type Pace = "relaxed" | "balanced" | "packed";

export type RecommendItineraryInput = {
  destination: string;
  start_date?: string | null;
  end_date?: string | null;
  days?: number;
  members_count?: number;
  interests?: string[];
  budget_level?: BudgetLevel;
  pace?: Pace;
  base_currency?: string;
};

export type RecommendedSchedule = {
  title: string;
  date: string | null;
  start_at: string | null;
  end_at: string | null;
  location: string | null;
  planned_budget: number;
  budget_note: string;
  reason: string;
};

const byLevel: Record<BudgetLevel, number> = {
  budget: 0.75,
  mid: 1,
  premium: 1.55,
};

const byPace: Record<Pace, number> = {
  relaxed: 2,
  balanced: 3,
  packed: 4,
};

function dateAdd(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function daysBetween(start?: string | null, end?: string | null, fallback = 3) {
  if (!start || !end) return fallback;
  const s = Date.parse(`${start}T00:00:00+09:00`);
  const e = Date.parse(`${end}T00:00:00+09:00`);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return fallback;
  return Math.max(1, Math.round((e - s) / 86400000) + 1);
}

function slotTimes(date: string | null, index: number) {
  if (!date) return { start_at: null, end_at: null };
  const slots = [
    ["10:00:00", "12:00:00"],
    ["13:30:00", "15:30:00"],
    ["17:00:00", "19:00:00"],
    ["20:00:00", "22:00:00"],
  ];
  const [start, end] = slots[index % slots.length];
  return { start_at: `${date}T${start}+09:00`, end_at: `${date}T${end}+09:00` };
}

function titleFor(destination: string, interest: string, day: number, slot: number) {
  const lower = interest.toLowerCase();
  if (lower.includes("마사지") || lower.includes("스파")) return `${destination} 스파/마사지`;
  if (lower.includes("야시장") || lower.includes("시장")) return `${destination} 야시장 먹방`;
  if (lower.includes("카페")) return `${destination} 로컬 카페`;
  if (lower.includes("쇼핑")) return `${destination} 쇼핑 스팟`;
  if (lower.includes("맛집") || lower.includes("음식") || lower.includes("식사")) return `${destination} 현지 맛집`;
  if (lower.includes("관광") || lower.includes("랜드마크")) return `${destination} 대표 관광지`;
  if (lower.includes("자연") || lower.includes("휴양")) return `${destination} 휴양 코스`;
  const defaults = ["도착/체크인", "대표 맛집", "동네 산책", "기념품 쇼핑"];
  return `${destination} ${interest || defaults[(day + slot) % defaults.length]}`;
}

function baseBudget(interest: string, members: number) {
  const lower = interest.toLowerCase();
  const perPerson =
    lower.includes("스파") || lower.includes("마사지") ? 70000 :
    lower.includes("쇼핑") ? 50000 :
    lower.includes("맛집") || lower.includes("음식") || lower.includes("식사") || lower.includes("야시장") ? 30000 :
    lower.includes("카페") ? 16000 :
    lower.includes("관광") || lower.includes("랜드마크") ? 25000 :
    22000;
  return perPerson * Math.max(1, members);
}

export function recommendTripItinerary(input: RecommendItineraryInput) {
  const destination = input.destination || "여행지";
  const pace = input.pace ?? "balanced";
  const budgetLevel = input.budget_level ?? "mid";
  const members = Math.max(1, Number(input.members_count || 1));
  const interests = input.interests?.length ? input.interests : ["맛집", "카페", "관광", "쇼핑"];
  const dayCount = input.days ?? daysBetween(input.start_date, input.end_date, 3);
  const slotsPerDay = byPace[pace];
  const multiplier = byLevel[budgetLevel];
  const schedules: RecommendedSchedule[] = [];

  for (let day = 0; day < dayCount; day++) {
    const date = input.start_date ? dateAdd(input.start_date, day) : null;
    for (let slot = 0; slot < slotsPerDay; slot++) {
      const interest = interests[(day * slotsPerDay + slot) % interests.length];
      const times = slotTimes(date, slot);
      const planned = Math.round((baseBudget(interest, members) * multiplier) / 1000) * 1000;
      schedules.push({
        title: titleFor(destination, interest, day, slot),
        date,
        ...times,
        location: destination,
        planned_budget: planned,
        budget_note: `${members}명 기준 ${interest} 예상비`,
        reason: `${destination} 여행에서 '${interest}' 선호를 일정과 예산 단위로 연결했습니다.`,
      });
    }
  }

  const total_budget = schedules.reduce((sum, s) => sum + s.planned_budget, 0);
  return {
    destination,
    base_currency: input.base_currency ?? "KRW",
    days: dayCount,
    members_count: members,
    budget_level: budgetLevel,
    pace,
    total_budget,
    schedules,
  };
}
