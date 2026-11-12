/** Shared last city-trade hop (no imports from sim / merchantEconomy — avoids cycles). */
export type CityTradeHop = {
  from: string;
  to: string;
  amount: number;
  label: string;
  at: number;
};

let latest: CityTradeHop | undefined;

export function setLatestCityTrade(hop: CityTradeHop): void {
  latest = hop;
}

export function getLatestCityTrade(): CityTradeHop | undefined {
  return latest;
}

export function clearLatestCityTrade(): void {
  latest = undefined;
}

export function formatCityTradeLine(t: CityTradeHop): string {
  const name = (id: string) => (id === 'chef' ? 'Chef' : id === 'smith' ? 'Smith' : id === 'dealer' ? 'Dealer' : id);
  return `${name(t.from)} → ${name(t.to)} ${t.amount} GD · ${t.label}`;
}
