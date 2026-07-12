import type { SettlementResult } from "./settlement.js";

export type SettlementTransferExport = {
  from: string;
  to: string;
  amount: number;
  toss?: string | null;
  toss_link?: string | null;
  kakaopay_link?: string | null;
  payee_account?: string | null;
};

export type SettlementExportInput = {
  tripName: string;
  baseCurrency: string;
  mode: SettlementResult["mode"];
  total: number;
  perMember: Array<{
    name?: string;
    paid: number;
    owed: number;
    net: number;
  }>;
  transfers: SettlementTransferExport[];
};

export type SettlementExport = {
  kakao_text: string;
  csv: string;
  card: {
    title: string;
    subtitle: string;
    total_label: string;
    status: string;
    rows: Array<{ label: string; value: string; tone: "receive" | "send" | "settled" }>;
    transfers: Array<{ route: string; amount: string; account: string | null }>;
  };
};

const formatMoney = (amount: number, currency: string) =>
  `${Math.round(amount).toLocaleString()} ${currency}`;

const csvCell = (value: string | number | null | undefined) => {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function modeLabel(mode: SettlementResult["mode"]) {
  if (mode === "shares") return "분담기록 기준";
  if (mode === "individual") return "각자부담";
  return "N빵";
}

export function buildSettlementExport(input: SettlementExportInput): SettlementExport {
  const head = `[TripMoney] ${input.tripName} 정산 결과`;
  const total = formatMoney(input.total, input.baseCurrency);
  const transferLines = input.transfers.length
    ? input.transfers.map((t) => {
        const account = t.payee_account ? ` (${t.payee_account})` : "";
        return `- ${t.from} -> ${t.to}: ${formatMoney(t.amount, input.baseCurrency)}${account}`;
      })
    : ["- 추가 송금 없음"];
  const kakao_text = [
    head,
    `총 지출: ${total}`,
    `방식: ${modeLabel(input.mode)}`,
    "",
    "송금 요청",
    ...transferLines,
    "",
    "멤버별 정산",
    ...input.perMember.map((m) => {
      const name = m.name || "이름 없음";
      const sign = m.net > 0 ? "받을 금액" : m.net < 0 ? "보낼 금액" : "정산 완료";
      return `- ${name}: ${sign} ${formatMoney(Math.abs(m.net), input.baseCurrency)}`;
    }),
  ].join("\n");

  const csvRows = [
    ["section", "name", "paid", "owed", "net", "from", "to", "amount", "account"],
    ...input.perMember.map((m) => [
      "member",
      m.name || "",
      m.paid,
      m.owed,
      m.net,
      "",
      "",
      "",
      "",
    ]),
    ...input.transfers.map((t) => [
      "transfer",
      "",
      "",
      "",
      "",
      t.from,
      t.to,
      t.amount,
      t.payee_account || "",
    ]),
  ];
  const csv = csvRows.map((row) => row.map(csvCell).join(",")).join("\n");

  const rows = input.perMember.map((m) => ({
    label: m.name || "이름 없음",
    value: formatMoney(Math.abs(m.net), input.baseCurrency),
    tone: (m.net > 0 ? "receive" : m.net < 0 ? "send" : "settled") as "receive" | "send" | "settled",
  }));

  return {
    kakao_text,
    csv,
    card: {
      title: `${input.tripName} 정산 카드`,
      subtitle: `${modeLabel(input.mode)} · ${input.perMember.length}명`,
      total_label: total,
      status: input.transfers.length ? `${input.transfers.length}건 송금 필요` : "정산 완료",
      rows,
      transfers: input.transfers.map((t) => ({
        route: `${t.from} -> ${t.to}`,
        amount: formatMoney(t.amount, input.baseCurrency),
        account: t.payee_account || null,
      })),
    },
  };
}
