import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Badge,
  Button,
  Container,
  Heading,
  Input,
  Switch,
  Table,
  Text,
} from "@medusajs/ui";
import { CurrencyDollar } from "@medusajs/icons";
import type { RouteConfig } from "@mercurjs/dashboard-sdk";
import { useEconomy, useFxHistory, useFxRate, useSetFxRate } from "../../lib/queries";
import { rm } from "../../lib/format";

export const config: RouteConfig = {
  label: "Economy",
  icon: CurrencyDollar,
  rank: 30,
};

const FxCard = () => {
  const { data: fx } = useFxRate();
  const { data: history } = useFxHistory();
  const setFx = useSetFxRate();
  const [override, setOverride] = useState(false);
  const [rate, setRate] = useState("");
  const [reason, setReason] = useState("");
  const [seeded, setSeeded] = useState(false);
  if (fx && !seeded) {
    setSeeded(true);
    setOverride(fx.manual_override);
    setRate(fx.manual_rate != null ? String(fx.manual_rate) : "");
  }

  const rateNum = Number(rate);
  const rateValid =
    !override || (Number.isFinite(rateNum) && rateNum > 0 && rateNum <= 1000);
  const canSave = !setFx.isPending && rateValid && reason.trim().length > 0;

  const save = () => {
    if (!canSave) return;
    if (
      !window.confirm(
        "This reprices every card on the storefront immediately. Continue?",
      )
    )
      return;
    setFx.mutate({
      manual_override: override,
      manual_rate: override ? rateNum : null,
      reason: reason.trim(),
    });
    setReason("");
  };

  return (
    <Container className="p-0">
      <div className="px-6 py-4">
        <Heading level="h2">Exchange rate (USD → MYR)</Heading>
        <Text className="text-ui-fg-subtle mt-1" size="small">
          Effective rate: {fx ? fx.effective.toFixed(4) : "…"}
          {fx?.manual_override ? " (manual override)" : " (auto)"}
        </Text>
      </div>
      <div className="flex flex-wrap items-end gap-4 border-t px-6 py-4">
        <div className="flex items-center gap-2">
          <Switch checked={override} onCheckedChange={setOverride} id="fx-ovr" />
          <Text size="small">Manual override</Text>
        </div>
        <div className="flex flex-col gap-y-1">
          <Text size="small" weight="plus">
            Rate
          </Text>
          <Input
            className="w-32"
            value={rate}
            disabled={!override}
            onChange={(e) => setRate(e.target.value)}
            placeholder="4.70"
          />
        </div>
        <div className="flex min-w-64 flex-1 flex-col gap-y-1">
          <Text size="small" weight="plus">
            Reason
          </Text>
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Required — why is the rate changing?"
          />
        </div>
        <Button
          size="small"
          onClick={save}
          isLoading={setFx.isPending}
          disabled={!canSave}
        >
          Save rate
        </Button>
      </div>
      {history && history.changes.length > 0 && (
        <div className="border-t px-6 py-4">
          <Text size="small" weight="plus">
            Recent changes
          </Text>
          <ul className="mt-2 flex flex-col gap-1">
            {history.changes.map((c, i) => (
              <li key={i} className="text-ui-fg-subtle text-sm">
                {new Date(c.at).toLocaleString("en-US")} — {c.admin_id}:{" "}
                {c.after.manual_override
                  ? `override → ${c.after.manual_rate}`
                  : "override off"}
                {c.reason ? ` (${c.reason})` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Container>
  );
};

const EconomyPage = () => {
  const { t } = useTranslation();
  const { data, isError } = useEconomy();

  const stats: { key: string; value: string; hint?: string }[] = data
    ? [
        { key: "revenue", value: rm(data.totals.revenue) },
        { key: "payouts", value: rm(data.totals.payouts) },
        { key: "net", value: rm(data.totals.net) },
        {
          key: "liability",
          value: rm(data.liability.market_value),
          hint: t("economy.liabilityHint", { count: data.liability.count }),
        },
        { key: "topups", value: rm(data.totals.topups) },
        { key: "adjustments", value: rm(data.totals.adjustments) },
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

      <FxCard />

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
