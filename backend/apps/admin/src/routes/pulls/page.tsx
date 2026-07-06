import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Container, Heading, Text, Table, Badge, StatusBadge } from "@medusajs/ui";
import { ChartBar } from "@medusajs/icons";
import type { RouteConfig } from "@mercurjs/dashboard-sdk";
import { usePulls } from "../../lib/queries";
import { resolveImageUrl } from "../../lib/image-url";
import { rm, timeAgo } from "../../lib/format";
import { Pager } from "../../components/Pager";

export const config: RouteConfig = {
  label: "Pull Ledger",
  icon: ChartBar,
  nested: "/gacha",
  rank: 3,
};

const PullLedgerPage = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [page, setPage] = useState(0);
  const { data, isError } = usePulls(page);

  return (
    <div className="flex flex-col gap-y-3">
      <Container className="p-0">
        <div className="px-6 py-4">
          <Heading level="h2">{t("pulls.title")}</Heading>
          <Text className="text-ui-fg-subtle mt-1" size="small">
            {t("pulls.subtitle")}
          </Text>
        </div>

        {isError ? (
          <div className="border-t px-6 py-8">
            <Text className="text-ui-fg-subtle">{t("pulls.loadError")}</Text>
          </div>
        ) : !data ? (
          <div className="border-t px-6 py-8">
            <Text className="text-ui-fg-subtle">…</Text>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-px border-t bg-ui-border-base md:grid-cols-3">
            <div className="bg-ui-bg-subtle px-6 py-4">
              <Text size="small" className="text-ui-fg-subtle">
                {t("pulls.total")}
              </Text>
              <Heading level="h1" className="mt-1 tabular-nums">
                {data.total.toLocaleString("en-US")}
              </Heading>
            </div>
            <div className="bg-ui-bg-subtle px-6 py-4">
              <Text size="small" className="text-ui-fg-subtle">
                {t("pulls.topRarities")}
              </Text>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {data.topRarities.length === 0 ? (
                  <Text size="small" className="text-ui-fg-muted">
                    {t("pulls.empty")}
                  </Text>
                ) : (
                  data.topRarities.map((r) => (
                    <Badge key={r.rarity} size="2xsmall">
                      {r.rarity} · {r.count}
                    </Badge>
                  ))
                )}
              </div>
            </div>
            <div className="bg-ui-bg-subtle px-6 py-4">
              <Text size="small" className="text-ui-fg-subtle">
                {t("pulls.topCards")}
              </Text>
              <ul className="mt-2 flex flex-col gap-1">
                {data.topCards.slice(0, 4).map((c) => (
                  <li key={c.handle} className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate">{c.name}</span>
                    <span className="text-ui-fg-subtle shrink-0 tabular-nums">×{c.count}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </Container>

      <Container className="p-0">
        <div className="px-6 py-4">
          <Heading level="h2">{t("pulls.recent")}</Heading>
        </div>
        {data && data.pulls.length > 0 ? (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>{t("pulls.card")}</Table.HeaderCell>
                <Table.HeaderCell>{t("pulls.rarity")}</Table.HeaderCell>
                <Table.HeaderCell className="text-right">{t("pulls.value")}</Table.HeaderCell>
                <Table.HeaderCell>{t("pulls.customer")}</Table.HeaderCell>
                <Table.HeaderCell>{t("pulls.pack")}</Table.HeaderCell>
                <Table.HeaderCell>{t("pulls.status")}</Table.HeaderCell>
                <Table.HeaderCell className="text-right">{t("pulls.when")}</Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {data.pulls.map((p) => (
                <Table.Row key={p.id}>
                  <Table.Cell>
                    <div className="flex items-center gap-3">
                      {p.card?.image && (
                        <img src={resolveImageUrl(p.card.image)} alt="" className="h-10 w-8 shrink-0 rounded object-contain" />
                      )}
                      <span className="max-w-[20rem] truncate">{p.card?.name ?? p.card?.handle ?? "—"}</span>
                    </div>
                  </Table.Cell>
                  <Table.Cell>{p.card?.rarity ? <Badge size="2xsmall">{p.card.rarity}</Badge> : "—"}</Table.Cell>
                  <Table.Cell className="text-ui-fg-subtle text-right tabular-nums">
                    {rm(p.card?.market_value ?? null)}
                  </Table.Cell>
                  <Table.Cell className="text-ui-fg-subtle">
                    {p.customer_id ? (
                      <button
                        type="button"
                        className="text-ui-fg-interactive hover:underline"
                        onClick={() => navigate(`/customers/${p.customer_id}`)}
                      >
                        {p.customer_email ?? p.customer_id.slice(0, 8)}
                      </button>
                    ) : (
                      t("pulls.anon")
                    )}
                  </Table.Cell>
                  <Table.Cell className="text-ui-fg-subtle">{p.pack_title ?? p.pack_id.slice(0, 8)}</Table.Cell>
                  <Table.Cell>
                    {p.status === "bought_back" ? (
                      <StatusBadge color="orange">
                        {t("pulls.boughtBack", { amount: rm(p.buyback_amount) })}
                      </StatusBadge>
                    ) : (
                      <StatusBadge color="green">{t("pulls.vaulted")}</StatusBadge>
                    )}
                  </Table.Cell>
                  <Table.Cell className="text-ui-fg-subtle text-right">{timeAgo(p.rolled_at)}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        ) : (
          <div className="border-t px-6 py-8">
            <Text className="text-ui-fg-subtle">{t("pulls.empty")}</Text>
          </div>
        )}
        {data && (
          <Pager
            page={page}
            onPage={setPage}
            pageSize={data.limit}
            count={data.pulls.length}
            total={data.total}
          />
        )}
      </Container>
    </div>
  );
};

export default PullLedgerPage;
