export type MesQuarterMonthCode = "H" | "M" | "U" | "Z";

export interface MesFuturesInstrument {
  underlying: "MES";
  exchange: "CME";
  symbol: string;
  contractCode: string;
  contractMonth: 3 | 6 | 9 | 12;
  contractMonthCode: MesQuarterMonthCode;
  contractYear: number;
  tickSize: 0.25;
  tickValue: 1.25;
  pointValue: 5;
}

type QuarterSpec = {
  month: 3 | 6 | 9 | 12;
  code: MesQuarterMonthCode;
};

const MES_QUARTERLY_CONTRACTS: readonly QuarterSpec[] = [
  { month: 3, code: "H" },
  { month: 6, code: "M" },
  { month: 9, code: "U" },
  { month: 12, code: "Z" },
] as const;

function getChicagoDateParts(asOf: Date): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });

  const parts = formatter.formatToParts(asOf);
  const lookup = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));

  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
  };
}

function getThirdFridayDayOfMonth(year: number, month: number): number {
  let fridayCount = 0;

  for (let day = 1; day <= 31; day += 1) {
    const probe = new Date(Date.UTC(year, month - 1, day));
    if (probe.getUTCMonth() !== month - 1) break;

    if (probe.getUTCDay() === 5) {
      fridayCount += 1;
      if (fridayCount === 3) return day;
    }
  }

  throw new Error(`Cannot determine third Friday for ${year}-${String(month).padStart(2, "0")}`);
}

function getNextQuarterContract(year: number, month: number): QuarterSpec & { year: number } {
  for (const contract of MES_QUARTERLY_CONTRACTS) {
    if (month < contract.month) return { ...contract, year };
  }

  return { ...MES_QUARTERLY_CONTRACTS[0], year: year + 1 };
}

export function getMesFrontMonthContract(asOf: Date = new Date()): { contractMonth: 3 | 6 | 9 | 12; contractMonthCode: MesQuarterMonthCode; contractYear: number } {
  const { year, month, day } = getChicagoDateParts(asOf);

  for (const contract of MES_QUARTERLY_CONTRACTS) {
    if (month < contract.month) {
      return {
        contractMonth: contract.month,
        contractMonthCode: contract.code,
        contractYear: year,
      };
    }

    if (month === contract.month) {
      const thirdFriday = getThirdFridayDayOfMonth(year, month);
      if (day <= thirdFriday) {
        return {
          contractMonth: contract.month,
          contractMonthCode: contract.code,
          contractYear: year,
        };
      }

      const nextContract = getNextQuarterContract(year, month);
      return {
        contractMonth: nextContract.month,
        contractMonthCode: nextContract.code,
        contractYear: nextContract.year,
      };
    }
  }

  const nextContract = getNextQuarterContract(year, month);
  return {
    contractMonth: nextContract.month,
    contractMonthCode: nextContract.code,
    contractYear: nextContract.year,
  };
}

export function formatMesSymbol(contractMonthCode: MesQuarterMonthCode, contractYear: number): string {
  return `/MES${contractMonthCode}${String(contractYear % 10)}`;
}

export function resolveMesFrontMonthInstrument(asOf: Date = new Date()): MesFuturesInstrument {
  const frontMonth = getMesFrontMonthContract(asOf);
  const contractCode = `MES${frontMonth.contractMonthCode}${String(frontMonth.contractYear % 10)}`;

  return {
    underlying: "MES",
    exchange: "CME",
    symbol: `/${contractCode}`,
    contractCode,
    contractMonth: frontMonth.contractMonth,
    contractMonthCode: frontMonth.contractMonthCode,
    contractYear: frontMonth.contractYear,
    tickSize: 0.25,
    tickValue: 1.25,
    pointValue: 5,
  };
}
