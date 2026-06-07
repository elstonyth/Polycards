import type { Metadata } from "next";
import {
  getMarketplaceCards,
  getMarketplaceCategories,
} from "@/lib/data/products";
import MarketplaceClient from "./MarketplaceClient";

export const metadata: Metadata = {
  title: "Marketplace — Phygitals",
  description:
    "Buy and sell real graded cards with other collectors. Real cards, real ownership, instant transfers.",
};

export default function MarketplacePage() {
  const cards = getMarketplaceCards();
  const categories = getMarketplaceCategories();
  return <MarketplaceClient cards={cards} categories={categories} />;
}
