import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Button,
  Container,
  Heading,
  Input,
  Label,
  Table,
  Text,
  toast,
} from "@medusajs/ui";
import type { RouteConfig } from "@mercurjs/dashboard-sdk";
import { listPlayers, type PlayersPage } from "../../lib/admin-rest";
import { orderDateTime } from "../../lib/format";
import { supportSearchQuery } from "./search-query";

export const config: RouteConfig = {
  label: "pcNav.customerSupport",
  translationNs: "translation",
  rank: 2,
  nested: "/players",
};

const RESULT_LIMIT = 10;

// Finds a player and opens their page, which holds the credits, ledger, pulls,
// vault and adjustments support works from.
const SupportPage = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PlayersPage | null>(null);
  const [searching, setSearching] = useState(false);

  const search = async () => {
    const q = supportSearchQuery(query);
    if (!q || searching) return;
    setSearching(true);
    try {
      setResults(await listPlayers(0, q, RESULT_LIMIT));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      setResults(null);
    } finally {
      setSearching(false);
    }
  };

  const open = (id: string) => navigate(`/customers/${id}`);

  return (
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
            // The route reads at most 100 characters of ?q=.
            maxLength={100}
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
      {results !== null && (
        <div className="border-t">
          {results.players.length === 0 ? (
            <div className="px-6 py-6">
              <Text className="text-ui-fg-subtle">
                {t("support.noMatches")}
              </Text>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <Table.Header>
                    <Table.Row>
                      <Table.HeaderCell>{t("players.name")}</Table.HeaderCell>
                      <Table.HeaderCell>{t("players.phone")}</Table.HeaderCell>
                      <Table.HeaderCell className="text-right">
                        {t("players.registered")}
                      </Table.HeaderCell>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {results.players.map((p) => (
                      <Table.Row
                        key={p.id}
                        className="cursor-pointer"
                        onClick={() => open(p.id)}
                      >
                        <Table.Cell>
                          {/* A real button so the row works by keyboard too. */}
                          <button
                            type="button"
                            className="text-ui-fg-interactive focus-visible:shadow-borders-interactive-with-focus block rounded-md text-left outline-none hover:underline"
                            onClick={(e) => {
                              e.stopPropagation();
                              open(p.id);
                            }}
                          >
                            {p.name ?? p.email}
                          </button>
                          <Text
                            as="span"
                            size="xsmall"
                            className="text-ui-fg-subtle block"
                          >
                            {p.email}
                          </Text>
                        </Table.Cell>
                        <Table.Cell className="text-ui-fg-subtle whitespace-nowrap">
                          {p.phone ?? "—"}
                        </Table.Cell>
                        <Table.Cell className="text-ui-fg-subtle whitespace-nowrap text-right">
                          {orderDateTime(p.registered_at)}
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
              </div>
              {results.total > results.players.length && (
                <div className="border-t px-6 py-3">
                  <Text className="text-ui-fg-subtle" size="small">
                    {t("support.moreMatches", {
                      shown: results.players.length,
                      total: results.total,
                    })}
                  </Text>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Container>
  );
};

export default SupportPage;
