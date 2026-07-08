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

  const stats: {
    key: string;
    value: string;
    hint?: string;
    current?: boolean;
  }[] = data
    ? [
        { key: "revenue", value: rm(data.totals.revenue) },
        { key: "payouts", value: rm(data.totals.payouts) },
        { key: "net", value: rm(data.totals.net) },
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
                <Heading level="h1" className="mt-1 tabular-nums">
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
                <Table.HeaderCell>{t("economy.pack")}</Table.HeaderCell>
                <Table.HeaderCell>{t("economy.category")}</Table.HeaderCell>
                <Table.HeaderCell className="text-right">
                  {t("economy.price")}
                </Table.HeaderCell>
                <Table.HeaderCell className="text-right">
                  {t("economy.ev")}
                </Table.HeaderCell>
                <Table.HeaderCell className="text-right">
                  {t("economy.rtp")}
                </Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {data.packs.map((p) => (
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
