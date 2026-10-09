import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Container, Heading, Input, Text } from "@medusajs/ui";
import { ChartBar } from "@medusajs/icons";
import type { RouteConfig } from "@mercurjs/dashboard-sdk";
import { useStats } from "../../lib/queries";
import type { SignupTopupStats, StatsRange } from "../../lib/admin-rest";
import { rm } from "../../lib/format";
import { LoadingSkeleton } from "../../components/LoadingSkeleton";

// rank 0 = the top group of the custom nav. The SDK only reads a numeric
// LITERAL here, so a negative rank (a unary expression) would be ignored.
export const config: RouteConfig = {
  label: "Stats",
  icon: ChartBar,
  rank: 0,
};

const RANGES: StatsRange[] = [
  "today",
  "yesterday",
  "7d",
  "30d",
  "month",
  "last_month",
  "custom",
];

// Card order. Money cards read RM; the rest are counts.
const CARDS: { key: keyof SignupTopupStats; money?: boolean }[] = [
  { key: "signups" },
  { key: "topup_customers" },
  { key: "topup_count" },
  { key: "topup_amount", money: true },
  { key: "first_topup_count" },
  { key: "first_topup_amount", money: true },
  { key: "withdrawal_count" },
  { key: "withdrawal_amount", money: true },
];

// The backend's windows are MYT (fixed UTC+8). Shift, then read the UTC
// fields, so the text is MYT whatever timezone the viewer's browser is in.
const MYT_MS = 8 * 3_600_000;
const mytText = (iso: string) =>
  new Date(Date.parse(iso) + MYT_MS).toISOString().slice(0, 16).replace("T", " ");
const windowText = (w: { from: string; to: string }) =>
  `${mytText(w.from)} – ${mytText(w.to)}`;
const todayMyt = () => new Date(Date.now() + MYT_MS).toISOString().slice(0, 10);

const StatsPage = () => {
  const { t } = useTranslation();
  const [range, setRange] = useState<StatsRange>("today");
  const [from, setFrom] = useState(todayMyt);
  const [to, setTo] = useState(todayMyt);
  const custom = range === "custom";
  // YYYY-MM-DD strings order correctly as plain strings.
  const customValid = from !== "" && to !== "" && from <= to;
  const { data, isError } = useStats(
    range,
    custom ? from : "",
    custom ? to : "",
  );

  const notice =
    custom && !customValid
      ? t("statsBoard.customHint")
      : isError
        ? t("statsBoard.loadError")
        : null;

  return (
    <Container className="p-0">
      <div className="flex flex-col gap-3 px-6 py-4">
        <div>
          <Heading level="h2">{t("statsBoard.title")}</Heading>
          {data && (
            <Text className="text-ui-fg-subtle mt-1" size="small">
              {t("statsBoard.subtitle", {
                current: windowText(data.current),
                previous: windowText(data.previous),
              })}
            </Text>
          )}
        </div>
        <div className="flex flex-wrap gap-1">
          {RANGES.map((r) => (
            <Button
              key={r}
              size="small"
              variant={range === r ? "primary" : "secondary"}
              onClick={() => setRange(r)}
            >
              {t(`statsBoard.ranges.${r}`)}
            </Button>
          ))}
        </div>
        {custom && (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="date"
              className="w-40"
              aria-label={t("statsBoard.from")}
              value={from}
              max={todayMyt()}
              onChange={(e) => setFrom(e.target.value)}
            />
            <Input
              type="date"
              className="w-40"
              aria-label={t("statsBoard.to")}
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
        )}
      </div>

      {notice || !data ? (
        <div className="border-t px-6 py-8">
          {notice ? (
            <Text className="text-ui-fg-subtle">{notice}</Text>
          ) : (
            <LoadingSkeleton />
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-px border-t bg-ui-border-base lg:grid-cols-4">
          {CARDS.map(({ key, money }) => {
            const cur = data.current.stats[key];
            const prev = data.previous.stats[key];
            const fmt = (n: number) =>
              money ? rm(n) : n.toLocaleString("en-US");
            // No % against a zero base: "—" instead of Infinity.
            const pct = prev === 0 ? null : ((cur - prev) / prev) * 100;
            const tone =
              pct === null || pct === 0
                ? "text-ui-fg-subtle"
                : pct > 0
                  ? "text-ui-tag-green-text"
                  : "text-ui-fg-error";
            const arrow =
              pct === null || pct === 0 ? "" : pct > 0 ? "▲ " : "▼ ";
            return (
              <div key={key} className="bg-ui-bg-subtle px-6 py-4">
                <Text size="small" className="text-ui-fg-subtle">
                  {t(`statsBoard.${key}`)}
                </Text>
                <Heading level="h1" className="mt-1 tabular-nums">
                  {fmt(cur)}
                </Heading>
                <Text size="small" className={`tabular-nums ${tone}`}>
                  {arrow}
                  {pct === null ? "—" : `${Math.abs(pct).toFixed(2)}%`}{" "}
                  {t("statsBoard.vsPrevious")}
                </Text>
                <Text size="small" className="text-ui-fg-muted tabular-nums">
                  {t("statsBoard.previous", { value: fmt(prev) })}
                </Text>
              </div>
            );
          })}
        </div>
      )}
    </Container>
  );
};

export default StatsPage;
