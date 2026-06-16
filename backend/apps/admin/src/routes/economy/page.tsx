import { useTranslation } from "react-i18next";
import { Badge, Container, Heading, Table, Text } from "@medusajs/ui";
import { CurrencyDollar } from "@medusajs/icons";
import type { RouteConfig } from "@mercurjs/dashboard-sdk";
import { useEconomy } from "../../lib/queries";

export const config: RouteConfig = {
  label: "Economy",
  icon: CurrencyDollar,
};

const usd = (n: number | null): string =>
  n === null
    ? "—"
    : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const EconomyPage = () => {
  const { t } = useTranslation();
  const { data, isError } = useEconomy();

  const stats: { key: string; value: string; hint?: string }[] = data
    ? [
        { key: "revenue", value: usd(data.totals.revenue) },
        { key: "payouts", value: usd(data.totals.payouts) },
        { key: "net", value: usd(data.totals.net) },
        {
          key: "liability",
          value: usd(data.liability.market_value),
          hint: t("economy.liabilityHint", { count: data.liability.count }),
        },
        { key: "topups", value: usd(data.totals.topups) },
        { key: "adjustments", value: usd(data.totals.adjustments) },
      ]
    : [];

  return (
    <div className="flex flex-col gap-y-3">
      <Container className="p-0">
        <div className="px-6 py-4">
          <Heading level="h2">{t("economy.title")}</Heading>
          <Text className="text-ui-fg-subtle mt-1" size="small">
            {t("economy.subtitle")}
          </Text>
        </div>

        {isError ? (
          <div className="border-t px-6 py-8">
            <Text className="text-ui-fg-subtle">{t("economy.loadError")}</Text>
          </div>
        ) : !data ? (
          <div className="border-t px-6 py-8">
            <Text className="text-ui-fg-subtle">…</Text>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-px border-t bg-ui-border-base md:grid-cols-3">
            {stats.map((s) => (
              <div key={s.key} className="bg-ui-bg-subtle px-6 py-4">
                <Text size="small" className="text-ui-fg-subtle">
                  {t(`economy.${s.key}`)}
                </Text>
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
        <div className="px-6 py-4">
          <Heading level="h2">{t("economy.rtpTitle")}</Heading>
          <Text className="text-ui-fg-subtle mt-1" size="small">
            {t("economy.rtpSubtitle")}
          </Text>
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
                    {usd(p.price)}
                  </Table.Cell>
                  <Table.Cell className="text-ui-fg-subtle text-right tabular-nums">
                    {usd(p.ev)}
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
