/**
 * Economic News Filter
 * - Fetches economic calendar from Finnhub API
 * - Blocks trading 15 minutes BEFORE and 15 minutes AFTER high-impact events
 * - High-impact events: CPI, NFP, FOMC, GDP, Unemployment, PPI, Retail Sales, Fed Speeches
 * - Refreshes calendar every hour
 * - Falls back to known recurring schedule if API unavailable
 */

const FINNHUB_KEY = process.env.FINNHUB_API_KEY || "";
const FINNHUB_BASE = "https://finnhub.io/api/v1";

// Block window: 15 minutes before and after event
const BLOCK_MINUTES_BEFORE = 15;
const BLOCK_MINUTES_AFTER = 15;

// Refresh interval: 1 hour
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

// ======== TYPES ========

export interface EconomicEvent {
  name: string;
  time: number;        // Unix timestamp (ms)
  timeStr: string;     // Human-readable time string
  impact: "high" | "medium" | "low";
  country: string;
  blockStart: number;  // Unix timestamp (ms) - 15 min before
  blockEnd: number;    // Unix timestamp (ms) - 15 min after
}

export interface NewsFilterStatus {
  enabled: boolean;
  blocked: boolean;
  currentBlockEvent: string | null;
  blockUntil: string | null;
  upcomingEvents: EconomicEvent[];
  lastRefresh: string;
  apiSource: string;
}

// ======== HIGH-IMPACT EVENT KEYWORDS ========

const HIGH_IMPACT_KEYWORDS = [
  // Employment
  "nonfarm payroll", "non-farm payroll", "nfp",
  "unemployment rate", "unemployment claims",
  "initial jobless claims", "continuing claims",
  "adp employment", "adp nonfarm",
  // Inflation
  "consumer price index", "cpi",
  "producer price index", "ppi",
  "core cpi", "core ppi",
  "pce price index", "core pce",
  // Fed
  "fomc", "federal funds rate", "fed interest rate",
  "fed chair", "powell", "fed speech",
  "fomc minutes", "fomc statement",
  "federal reserve",
  // GDP
  "gdp", "gross domestic product",
  // Retail
  "retail sales",
  // Other high-impact
  "ism manufacturing", "ism services",
  "michigan consumer sentiment",
  "consumer confidence",
  "housing starts", "building permits",
  "trade balance",
  "industrial production",
];

function isHighImpact(eventName: string): boolean {
  const lower = eventName.toLowerCase();
  return HIGH_IMPACT_KEYWORDS.some(kw => lower.includes(kw));
}

// ======== KNOWN RECURRING EVENTS (fallback when API unavailable) ========

function getKnownEventsForDate(date: Date): EconomicEvent[] {
  const events: EconomicEvent[] = [];
  const dayOfWeek = date.getDay(); // 0=Sun, 1=Mon, ...
  const dayOfMonth = date.getDate();
  const month = date.getMonth(); // 0-indexed

  // FOMC meetings (roughly every 6 weeks, 2pm ET announcement)
  // 2026 FOMC dates: Jan 28-29, Mar 18-19, May 6-7, Jun 17-18, Jul 29-30, Sep 16-17, Nov 4-5, Dec 16-17
  const fomcDates = [
    [0, 29], [2, 19], [4, 7], [5, 18], [6, 30], [8, 17], [10, 5], [11, 17]
  ];
  for (const [m, d] of fomcDates) {
    if (month === m && dayOfMonth === d) {
      const eventTime = new Date(date);
      eventTime.setHours(14, 0, 0, 0); // 2pm ET
      const ts = eventTime.getTime();
      events.push({
        name: "FOMC Interest Rate Decision",
        time: ts,
        timeStr: eventTime.toISOString(),
        impact: "high",
        country: "US",
        blockStart: ts - BLOCK_MINUTES_BEFORE * 60000,
        blockEnd: ts + BLOCK_MINUTES_AFTER * 60000,
      });
    }
  }

  // NFP - First Friday of every month, 8:30am ET
  if (dayOfWeek === 5 && dayOfMonth <= 7) {
    const eventTime = new Date(date);
    eventTime.setHours(8, 30, 0, 0);
    const ts = eventTime.getTime();
    events.push({
      name: "Nonfarm Payrolls (NFP)",
      time: ts,
      timeStr: eventTime.toISOString(),
      impact: "high",
      country: "US",
      blockStart: ts - BLOCK_MINUTES_BEFORE * 60000,
      blockEnd: ts + BLOCK_MINUTES_AFTER * 60000,
    });
  }

  // CPI - Usually around 10th-14th of month, 8:30am ET (Tuesday or Wednesday)
  if (dayOfMonth >= 10 && dayOfMonth <= 14 && (dayOfWeek === 2 || dayOfWeek === 3)) {
    const eventTime = new Date(date);
    eventTime.setHours(8, 30, 0, 0);
    const ts = eventTime.getTime();
    events.push({
      name: "Consumer Price Index (CPI)",
      time: ts,
      timeStr: eventTime.toISOString(),
      impact: "high",
      country: "US",
      blockStart: ts - BLOCK_MINUTES_BEFORE * 60000,
      blockEnd: ts + BLOCK_MINUTES_AFTER * 60000,
    });
  }

  // Initial Jobless Claims - Every Thursday, 8:30am ET
  if (dayOfWeek === 4) {
    const eventTime = new Date(date);
    eventTime.setHours(8, 30, 0, 0);
    const ts = eventTime.getTime();
    events.push({
      name: "Initial Jobless Claims",
      time: ts,
      timeStr: eventTime.toISOString(),
      impact: "high",
      country: "US",
      blockStart: ts - BLOCK_MINUTES_BEFORE * 60000,
      blockEnd: ts + BLOCK_MINUTES_AFTER * 60000,
    });
  }

  return events;
}

// ======== NEWS FILTER CLASS ========

export class EconomicNewsFilter {
  private events: EconomicEvent[] = [];
  private lastRefresh: number = 0;
  private enabled: boolean = true;
  private apiSource: string = "none";
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Initial fetch
    this.refresh().catch(e => console.error("[NewsFilter] Initial refresh failed:", e.message));
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    console.log(`[NewsFilter] ${enabled ? "Enabled" : "Disabled"}`);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  startAutoRefresh() {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => {
      this.refresh().catch(e => console.error("[NewsFilter] Auto-refresh failed:", e.message));
    }, REFRESH_INTERVAL_MS);
    console.log("[NewsFilter] Auto-refresh started (every 1 hour)");
  }

  stopAutoRefresh() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  async refresh(): Promise<void> {
    const now = new Date();
    const today = now.toISOString().split("T")[0];
    const tomorrow = new Date(now.getTime() + 86400000).toISOString().split("T")[0];

    // Try Finnhub API first
    if (FINNHUB_KEY) {
      try {
        const url = `${FINNHUB_BASE}/calendar/economic?from=${today}&to=${tomorrow}&token=${FINNHUB_KEY}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });

        if (res.ok) {
          const data = await res.json() as any;
          const rawEvents = data?.economicCalendar || data?.result || [];

          this.events = [];
          for (const ev of rawEvents) {
            const name = ev.event || ev.name || "";
            if (!isHighImpact(name)) continue;
            if (ev.country && ev.country !== "US") continue;

            // Parse event time
            let eventTime: number;
            if (ev.time) {
              // Finnhub returns time as "HH:MM:SS" in ET
              const [h, m] = ev.time.split(":").map(Number);
              const eventDate = new Date(now);
              eventDate.setHours(h, m, 0, 0);
              eventTime = eventDate.getTime();
            } else {
              // Default to 8:30 AM ET if no time
              const eventDate = new Date(now);
              eventDate.setHours(8, 30, 0, 0);
              eventTime = eventDate.getTime();
            }

            this.events.push({
              name,
              time: eventTime,
              timeStr: new Date(eventTime).toISOString(),
              impact: "high",
              country: "US",
              blockStart: eventTime - BLOCK_MINUTES_BEFORE * 60000,
              blockEnd: eventTime + BLOCK_MINUTES_AFTER * 60000,
            });
          }

          this.apiSource = "finnhub";
          this.lastRefresh = Date.now();
          console.log(`[NewsFilter] Finnhub: ${this.events.length} high-impact events today`);
          for (const ev of this.events) {
            console.log(`[NewsFilter]   - ${ev.name} @ ${new Date(ev.time).toLocaleTimeString("en-US", { timeZone: "America/New_York" })} ET`);
          }
          return;
        } else {
          console.warn(`[NewsFilter] Finnhub API error: ${res.status}`);
        }
      } catch (e: any) {
        console.warn(`[NewsFilter] Finnhub fetch failed: ${e.message}`);
      }
    }

    // Fallback: Use known recurring schedule
    const etNow = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    this.events = getKnownEventsForDate(etNow);
    this.apiSource = FINNHUB_KEY ? "finnhub-fallback" : "schedule-fallback";
    this.lastRefresh = Date.now();
    console.log(`[NewsFilter] Fallback schedule: ${this.events.length} known events today`);
    for (const ev of this.events) {
      console.log(`[NewsFilter]   - ${ev.name} @ ${new Date(ev.time).toLocaleTimeString("en-US", { timeZone: "America/New_York" })} ET`);
    }
  }

  /**
   * Check if trading should be blocked right now
   * Returns null if trading is allowed, or the blocking event details if blocked
   */
  checkBlock(): { blocked: boolean; event: EconomicEvent | null; reason: string } {
    if (!this.enabled) {
      return { blocked: false, event: null, reason: "" };
    }

    const now = Date.now();

    for (const ev of this.events) {
      if (now >= ev.blockStart && now <= ev.blockEnd) {
        const isBeforeEvent = now < ev.time;
        const minutesUntilEvent = Math.round((ev.time - now) / 60000);
        const minutesSinceEvent = Math.round((now - ev.time) / 60000);

        const reason = isBeforeEvent
          ? `[NewsFilter] BLOCKED: ${ev.name} in ${minutesUntilEvent} min | Block window: ${new Date(ev.blockStart).toLocaleTimeString("en-US", { timeZone: "America/New_York" })} - ${new Date(ev.blockEnd).toLocaleTimeString("en-US", { timeZone: "America/New_York" })} ET`
          : `[NewsFilter] BLOCKED: ${ev.name} was ${minutesSinceEvent} min ago | Resuming at ${new Date(ev.blockEnd).toLocaleTimeString("en-US", { timeZone: "America/New_York" })} ET`;

        console.log(reason);
        return { blocked: true, event: ev, reason };
      }
    }

    return { blocked: false, event: null, reason: "" };
  }

  /**
   * Get upcoming events within the next N hours
   */
  getUpcomingEvents(hoursAhead: number = 4): EconomicEvent[] {
    const now = Date.now();
    const cutoff = now + hoursAhead * 3600000;
    return this.events.filter(ev => ev.time > now && ev.time < cutoff);
  }

  /**
   * Get full status for API/UI
   */
  getStatus(): NewsFilterStatus {
    const block = this.checkBlock();
    return {
      enabled: this.enabled,
      blocked: block.blocked,
      currentBlockEvent: block.event?.name || null,
      blockUntil: block.event ? new Date(block.event.blockEnd).toISOString() : null,
      upcomingEvents: this.getUpcomingEvents(8),
      lastRefresh: this.lastRefresh ? new Date(this.lastRefresh).toISOString() : "never",
      apiSource: this.apiSource,
    };
  }

  /**
   * Simulate a block event (for testing when market is closed)
   */
  simulateEvent(name: string, minutesFromNow: number = 0): EconomicEvent {
    const eventTime = Date.now() + minutesFromNow * 60000;
    const event: EconomicEvent = {
      name,
      time: eventTime,
      timeStr: new Date(eventTime).toISOString(),
      impact: "high",
      country: "US",
      blockStart: eventTime - BLOCK_MINUTES_BEFORE * 60000,
      blockEnd: eventTime + BLOCK_MINUTES_AFTER * 60000,
    };
    this.events.push(event);
    console.log(`[NewsFilter] SIMULATED: ${name} @ ${new Date(eventTime).toISOString()} | Block: ${new Date(event.blockStart).toISOString()} - ${new Date(event.blockEnd).toISOString()}`);
    return event;
  }
}

// Singleton
export const newsFilter = new EconomicNewsFilter();
