import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Badge,
  Button,
  Container,
  Heading,
  Input,
  Label,
  Prompt,
  StatusBadge,
  Table,
  Text,
  toast,
} from "@medusajs/ui";
import { Buildings } from "@medusajs/icons";
import type { RouteConfig } from "@mercurjs/dashboard-sdk";
import { searchCustomers, type SupportCustomer } from "../../lib/admin-rest";
import { useAdjustCredits, useCustomerGacha } from "../../lib/queries";
import { resolveImageUrl } from "../../lib/image-url";

export const config: RouteConfig = {
  label: "Customer Support",
  icon: Buildings,
};

const usd = (n: number | null): string =>
  n === null
    ? "—"
    : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const SupportPage = () => {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SupportCustomer[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { data: view } = useCustomerGacha(selectedId);
  const adjustCredits = useAdjustCredits();
  // Adjust form state — string inputs, validated server-side (the backend owns
  // the money rules; surfacing its message keeps the two in lockstep).
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const adjusting = adjustCredits.isPending;
  // Money mutation behind an explicit confirm — a mistyped sign on a support
  // ticket must not apply on a single click.
  const [confirmOpen, setConfirmOpen] = useState(false);

  const search = async () => {
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true);
    setSelectedId(null);
    try {
      setResults(await searchCustomers(q));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      setResults(null);
    } finally {
      setSearching(false);
    }
  };

  const open = (id: string) => {
    setSelectedId(id);
    setAmount("");
    setNote("");
  };

  // Validate, then ask for confirmation — the actual mutation runs in
  // applyAdjust once the Prompt is accepted.
  const requestAdjust = () => {
    if (!view || adjusting) return;
    const value = Number(amount);
    if (!Number.isFinite(value)) {
      toast.error(t("support.adjustInvalid"));
      return;
    }
    setConfirmOpen(true);
  };

  const applyAdjust = async () => {
    if (!view || adjusting) return;
    const value = Number(amount);
    setConfirmOpen(false);
    try {
      const res = await adjustCredits.mutateAsync({
        id: view.customer.id,
        amount: value,
        note,
      });
      toast.success(
        t("support.adjusted", {
          amount: usd(res.amount),
          balance: usd(res.balance),
        }),
      );
      // Invalidation (in the hook) refetches the customer view → fresh ledger row.
      setAmount("");
      setNote("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex flex-col gap-y-3">
      <Container className="p-0">
        <div className="px-6 py-4">
          <Heading level="h2">{t("support.title")}</Heading>
          <Text className="text-ui-fg-subtle mt-1" size="small">
            {t("support.subtitle")}
          </Text>
        </div>
        <div className="flex items-end gap-2 border-t px-6 py-4">
          <div className="flex-1">
            <Label htmlFor="support-q" size="small">
              {t("support.searchLabel")}
            </Label>
            <Input
              id="support-q"
              value={query}
              placeholder={t("support.searchPlaceholder")}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && search()}
            />
          </div>
          <Button onClick={search} isLoading={searching}>
            {t("support.search")}
          </Button>
        </div>
        {results !== null && !view && (
          <div className="border-t">
            {results.length === 0 ? (
              <div className="px-6 py-6">
                <Text className="text-ui-fg-subtle">
                  {t("support.noMatches")}
                </Text>
              </div>
            ) : (
              <Table>
                <Table.Body>
                  {results.map((c) => (
                    <Table.Row
                      key={c.id}
                      className="cursor-pointer"
                      onClick={() => open(c.id)}
                    >
                      <Table.Cell>{c.email}</Table.Cell>
                      <Table.Cell className="text-ui-fg-subtle">
                        {c.first_name ?? "—"}
                      </Table.Cell>
                      <Table.Cell className="text-ui-fg-subtle text-right">
                        {new Date(c.created_at).toLocaleDateString("en-US")}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            )}
          </div>
        )}
      </Container>

      {view && (
        <>
          <Container className="p-0">
            <div className="flex items-center justify-between px-6 py-4">
              <div>
                <Heading level="h2">{view.customer.email}</Heading>
                <Text className="text-ui-fg-subtle mt-1" size="small">
                  {t("support.memberSince", {
                    date: new Date(view.customer.created_at).toLocaleDateString(
                      "en-US",
                    ),
                  })}
                </Text>
              </div>
              <Button
                variant="secondary"
                size="small"
                onClick={() => setSelectedId(null)}
              >
                {t("support.back")}
              </Button>
            </div>
            <div className="grid grid-cols-1 gap-px border-t bg-ui-border-base md:grid-cols-3">
              <div className="bg-ui-bg-subtle px-6 py-4">
                <Text size="small" className="text-ui-fg-subtle">
                  {t("support.balance")}
                </Text>
                <Heading level="h1" className="mt-1 tabular-nums">
                  {usd(view.balance)}
                </Heading>
              </div>
              <div className="bg-ui-bg-subtle px-6 py-4">
                <Text size="small" className="text-ui-fg-subtle">
                  {t("support.vault")}
                </Text>
                <Heading level="h1" className="mt-1 tabular-nums">
                  {view.vault.count}
                </Heading>
                <Text size="small" className="text-ui-fg-subtle">
                  {t("support.vaultValue", {
                    value: usd(view.vault.market_value),
                  })}
                </Text>
              </div>
              <div className="bg-ui-bg-subtle px-6 py-4">
                <Text size="small" className="text-ui-fg-subtle">
                  {t("support.adjustTitle")}
                </Text>
                <div className="mt-2 flex flex-col gap-2">
                  <Input
                    value={amount}
                    placeholder={t("support.adjustAmount")}
                    onChange={(e) => setAmount(e.target.value)}
                    aria-label={t("support.adjustAmount")}
                  />
                  <Input
                    value={note}
                    placeholder={t("support.adjustNote")}
                    onChange={(e) => setNote(e.target.value)}
                    aria-label={t("support.adjustNote")}
                  />
                  <Button
                    size="small"
                    onClick={requestAdjust}
                    isLoading={adjusting}
                    disabled={!amount.trim() || !note.trim()}
                  >
                    {t("support.adjustApply")}
                  </Button>
                </div>
              </div>
            </div>
          </Container>

          <Prompt
            open={confirmOpen}
            onOpenChange={(open) => {
              if (!open) setConfirmOpen(false);
            }}
          >
            <Prompt.Content>
              <Prompt.Header>
                <Prompt.Title>{t("support.adjustConfirmTitle")}</Prompt.Title>
                <Prompt.Description>
                  {t("support.adjustConfirmDescription", {
                    amount: usd(Number(amount)),
                    email: view.customer.email,
                  })}
                </Prompt.Description>
              </Prompt.Header>
              <Prompt.Footer>
                <Prompt.Cancel>{t("support.adjustCancel")}</Prompt.Cancel>
                <Prompt.Action onClick={applyAdjust}>
                  {t("support.adjustConfirm")}
                </Prompt.Action>
              </Prompt.Footer>
            </Prompt.Content>
          </Prompt>

          <Container className="p-0">
            <div className="px-6 py-4">
              <Heading level="h2">{t("support.ledger")}</Heading>
            </div>
            {view.transactions.length === 0 ? (
              <div className="border-t px-6 py-6">
                <Text className="text-ui-fg-subtle">{t("support.empty")}</Text>
              </div>
            ) : (
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.HeaderCell>{t("support.reason")}</Table.HeaderCell>
                    <Table.HeaderCell>{t("support.note")}</Table.HeaderCell>
                    <Table.HeaderCell className="text-right">
                      {t("support.amount")}
                    </Table.HeaderCell>
                    <Table.HeaderCell className="text-right">
                      {t("support.when")}
                    </Table.HeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {view.transactions.map((tx) => (
                    <Table.Row key={tx.id}>
                      <Table.Cell>
                        <Badge size="2xsmall">{tx.reason}</Badge>
                      </Table.Cell>
                      <Table.Cell className="text-ui-fg-subtle max-w-[24rem] truncate">
                        {tx.reference ?? "—"}
                      </Table.Cell>
                      <Table.Cell
                        className={`text-right tabular-nums ${tx.amount < 0 ? "text-ui-fg-error" : ""}`}
                      >
                        {usd(tx.amount)}
                      </Table.Cell>
                      <Table.Cell className="text-ui-fg-subtle text-right">
                        {new Date(tx.created_at).toLocaleString("en-US")}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            )}
          </Container>

          <Container className="p-0">
            <div className="px-6 py-4">
              <Heading level="h2">{t("support.pulls")}</Heading>
            </div>
            {view.pulls.length === 0 ? (
              <div className="border-t px-6 py-6">
                <Text className="text-ui-fg-subtle">{t("support.empty")}</Text>
              </div>
            ) : (
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.HeaderCell>{t("support.card")}</Table.HeaderCell>
                    <Table.HeaderCell>{t("support.pack")}</Table.HeaderCell>
                    <Table.HeaderCell className="text-right">
                      {t("support.value")}
                    </Table.HeaderCell>
                    <Table.HeaderCell>{t("support.status")}</Table.HeaderCell>
                    <Table.HeaderCell className="text-right">
                      {t("support.when")}
                    </Table.HeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {view.pulls.map((p) => (
                    <Table.Row key={p.id}>
                      <Table.Cell>
                        <div className="flex items-center gap-3">
                          {p.card?.image && (
                            <img
                              src={resolveImageUrl(p.card.image)}
                              alt=""
                              className="h-10 w-8 shrink-0 rounded object-contain"
                            />
                          )}
                          <span className="max-w-[20rem] truncate">
                            {p.card?.name ?? "—"}
                          </span>
                        </div>
                      </Table.Cell>
                      <Table.Cell className="text-ui-fg-subtle">
                        {p.pack_id}
                      </Table.Cell>
                      <Table.Cell className="text-ui-fg-subtle text-right tabular-nums">
                        {usd(p.card?.market_value ?? null)}
                      </Table.Cell>
                      <Table.Cell>
                        {p.status === "bought_back" ? (
                          <StatusBadge color="orange">
                            {t("pulls.boughtBack", {
                              amount: usd(p.buyback_amount),
                            })}
                          </StatusBadge>
                        ) : (
                          <StatusBadge color="green">
                            {t("pulls.vaulted")}
                          </StatusBadge>
                        )}
                      </Table.Cell>
                      <Table.Cell className="text-ui-fg-subtle text-right">
                        {new Date(p.rolled_at).toLocaleString("en-US")}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            )}
          </Container>
        </>
      )}
    </div>
  );
};

export default SupportPage;
