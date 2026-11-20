/**
 * Plain names for the business areas the knowledge checklist is split into
 * (2026-09-30, page guide). The areas are stored as codes such as
 * "payment_credit_terms"; turned into words mechanically they read
 * "Payment credit terms", "Returns replacement", "Extra unmapped information".
 * These are the names an owner would use. Anything not listed falls back to
 * displayLabel, so a new area still shows something readable.
 */
import { displayLabel } from "@/lib/display-labels";

const AREA_NAMES: Record<string, string> = {
  company_knowledge: "About the company",
  factual_company_profile: "Company facts",
  product_knowledge: "Products",
  product_varieties: "Product types and variants",
  product_applications: "What the products are used for",
  customer_knowledge: "Your customers",
  target_market_geography: "Where you sell",
  buyer_segments: "Kinds of buyers",
  lead_qualification: "When a buyer is a good fit",
  sales_process: "How you sell",
  whatsapp_communication: "WhatsApp replies",
  faqs: "Common questions",
  objection_handling: "Handling objections",
  payment_credit_terms: "Payment and credit",
  shipping_delivery: "Shipping and delivery",
  returns_replacement: "Returns and replacements",
  customization: "Custom orders",
  samples_catalogue_quotation_rules: "Samples, catalogue and quotes",
  pricing_policy: "Pricing",
  product_research_market_map: "Market research",
  campaign_strategy_knowledge: "Campaign plans",
  legal_terms_privacy: "Legal terms and privacy",
  internal_operations: "Internal operations",
  analytics_success_metrics: "Measuring success",
  extra_unmapped_information: "Other details",
  production_manufacturing: "Production",
  sourcing_stock: "Sourcing and stock",
};

export function knowledgeAreaName(key: string | undefined | null): string {
  if (!key) return "";
  return AREA_NAMES[key] || displayLabel(key);
}
