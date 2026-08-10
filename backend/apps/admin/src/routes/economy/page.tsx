import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Badge,
  Button,
  Container,
  Heading,
  Table,
  Text,
} from "@medusajs/ui";
import { CurrencyDollar } from "@medusajs/icons";
import type { RouteConfig } from "@mercurjs/dashboard-sdk";
import { useEconomy } from "../../lib/queries";
import { rm } from "../../lib/format";
import { useTableSort } from "../../lib/use-table-sort";
import { LoadingSkeleton } from "../../components/LoadingSkeleton";

export const config: RouteConfig = {
  label: "Economy",
  icon: CurrencyDollar,
  rank: 30,
};

// Period presets for the ledger-total filter. `from` is a snapshot at selection
// time (memoized below); `to` is always "now", so we omit it (nothing is
// future-dated). Only ledger totals are scoped — liability + RTP stay current.
type Period = "daily" | "weekly" | "monthly" | "yearly" | "overall";

// Client-side sort over the RTP table — the report is unpaged, every pack is
// in hand. Nullable ev/rtp_pct sort as -Infinity (inventory/list precedent).
type EconomySortKey = "pack" | "category" | "price" | "ev" | "rtp";
const DAY_MS = 86_400_000;

const PERIODS: { value: Period; label: string; scope: string }[] = [
  { value: "daily", label: "Daily", scope: "Today" },
  { value: "weekly", label: "Weekly", scope: "Last 7 days" },
  { value: "monthly", label: "Monthly", scope: "Last 30 days" },
  { value: "yearly", label: "Yearly", scope: "Last 365 days" },
  { value: "overall", label: "Overall", scope: "All time" },
];

// ISO lower bound for a period (undefined = no bound = all time). Daily uses
// LOCAL midnight (setHours, not setUTCHours) so "today" matches the operator's
// day, not UTC's.
const periodFrom = (period: Period): string | undefined => {
  const now = Date.now();
  switch (period) {
    case "daily": {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d.toISOString();
    }
    case "weekly":
      return new Date(now - 7 * DAY_MS).toISOString();
    case "monthly":
      return new Date(now - 30 * DAY_MS).toISOString();
    case "yearly":
      return new Date(now - 365 * DAY_MS).toISOString();
    case "overall":
      return undefined;
  }
};

const EconomyPage = () => {
  const { t } = useTranslation();
  const [period, setPeriod] = useState<Period>("overall");
  // Memoize so `from` is stable per selection — recomputing a fresh ISO each
  // render would change the query key every render and loop the refetch.
  const from = useMemo(() => periodFrom(period), [period]);
  const { data, isError } = useEconomy(from);
  const scope = PERIODS.find((p) => p.value === period)?.scope ?? "All time";
  // Starts NULL = keep the server's order until a column is picked.
  const { sort, sortHeader } = useTableSort<EconomySortKey>(null);

  const packRows = useMemo(() => {
    const list = data?.packs ?? [];
    if (!sort) return list;
    const dir = sort.dir === "asc" ? 1 : -1;
    const val = (p: (typeof list)[number]): number | string => {
      switch (sort.key) {
        case "pack":
          return p.title;
        case "category":
          return p.category;
        case "price":
          return p.price;
        case "ev":
          return p.ev ?? Number.NEGATIVE_INFINITY;
        case "rtp":
          return p.rtp_pct ?? Number.NEGATIVE_INFINITY;
      }
    };
    return [...list].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (typeof av === "string" && typeof bv === "string") {
        return dir * av.localeCompare(bv);
      }
      return dir * (av < bv ? -1 : av > bv ? 1 : 0);
    });
  }, [data, sort]);

  const stats: {
    key: string;
    value: string;
    hint?: string;
    current?: boolean;
    /**
     * Semantic ink for the figure, set only when the sign is the signal.
     * A literal union, not string: a typo in a Tailwind class is invisible at
     * runtime, so let the compiler catch it. Widen when a second tone earns
     * its place.
     */
    tone?: "text-ui-fg-error";
  }[] = data
    ? [
        { key: "revenue", value: rm(data.totals.revenue) },
        { key: "payouts", value: rm(data.totals.payouts) },
        {
          key: "net",
          value: rm(data.totals.net),
          // The one figure on this page whose sign changes what the operator
          // has to do. Positive stays default ink — margin is the expected
          // state, so only the loss shouts.
          tone: data.totals.net < 0 ? "text-ui-fg-error" : undefined,
        },
        {
          key: "liability",
          value: rm(data.liability.market_value),
          hint: t("economy.liabilityHint", { count: data.liability.count }),
          current: true,
        },
        { key: "topups", value: rm(data.totals.topups) },
        { key: "adjustments", value: rm(data.totals.adjustments) },
      ]
    : [];

  return (
    <div className="flex flex-col gap-y-3">
      <Container className="p-0">
        <div className="flex flex-wrap items-start justify-between gap-3 px-6 py-4">
          <div>
            <Heading level="h2">{t("economy.title")}</Heading>
            <Text className="text-ui-fg-subtle mt-1" size="small">
              {t("economy.subtitle")} · ledger totals for {scope}
            </Text>
          </div>
          <div className="flex flex-wrap gap-1">
            {PERIODS.map((p) => (
              <Button
                key={p.value}
                size="small"
                variant={period === p.value ? "primary" : "secondary"}
                onClick={() => setPeriod(p.value)}
              >
                {p.label}
              </Button>
            ))}
          </div>
        </div>

        {isError ? (
          <div className="border-t px-6 py-8">
            <Text className="text-ui-fg-subtle">{t("economy.loadError")}</Text>
          </div>
        ) : !data ? (
          <div className="border-t px-6 py-8">
            <LoadingSkeleton />
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-px border-t bg-ui-border-base md:grid-cols-3">
            {stats.map((s) => (
              <div key={s.key} className="bg-ui-bg-subtle px-6 py-4">
                <div className="flex items-center gap-2">
                  <Text size="small" className="text-ui-fg-subtle">
                    {t(`economy.${s.key}`)}
                  </Text>
                  {s.current && (
                    <Badge size="2xsmall" color="grey">
                      current
                    </Badge>
                  )}
                </div>
                <Heading
                  level="h1"
                  className={`mt-1 tabular-nums ${s.tone ?? ""}`}
                >
                  {s.value}
                </Heading>
                {s.hint && (
                  <Text size="small" className="text-ui-fg-subtle">
                    {s.hint}
                  </Text>
                )}
              </div>
            ))}
          </div>
        )}
      </Container>

      <Container className="p-0">
        <div className="flex flex-wrap items-center gap-2 px-6 py-4">
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <Heading level="h2">{t("economy.rtpTitle")}</Heading>
              <Badge size="2xsmall" color="grey">
                current
              </Badge>
            </div>
            <Text className="text-ui-fg-subtle mt-1" size="small">
              {t("economy.rtpSubtitle")}
            </Text>
          </div>
        </div>
        {data && data.packs.length > 0 ? (
          <Table>
            <Table.Header>
              <Table.Row>
                {sortHeader("pack", t("economy.pack"))}
                {sortHeader("category", t("economy.category"))}
                {sortHeader("price", t("economy.price"), true)}
                {sortHeader("ev", t("economy.ev"), true)}
                {sortHeader("rtp", t("economy.rtp"), true)}
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {packRows.map((p) => (
                <Table.Row key={p.slug}>
                  <Table.Cell>{p.title}</Table.Cell>
                  <Table.Cell className="text-ui-fg-subtle">
                    {p.category}
                  </Table.Cell>
                  <Table.Cell className="text-right tabular-nums">
                    {rm(p.price)}
                  </Table.Cell>
                  <Table.Cell className="text-ui-fg-subtle text-right tabular-nums">
                    {rm(p.ev)}
                  </Table.Cell>
                  <Table.Cell className="text-right">
                    {p.rtp_pct === null ? (
                      "—"
                    ) : (
                      <Badge
                        size="2xsmall"
                        color={p.rtp_pct > 100 ? "red" : "grey"}
                      >
                        {p.rtp_pct.toFixed(2)}%
                      </Badge>
                    )}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        ) : (
          <div className="border-t px-6 py-8">
            <Text className="text-ui-fg-subtle">{t("economy.empty")}</Text>
          </div>
        )}
      </Container>
    </div>
  );
};

export default EconomyPage;
