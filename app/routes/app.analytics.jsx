import { useLoaderData, useNavigate, useSearchParams } from "react-router";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Badge,
  ProgressBar,
  DataTable,
  Box,
  Select,
} from "@shopify/polaris";
import { useCallback } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getOrCreatePlan } from "../utils/plans.server";

// ─── Loader ──────────────────────────────────────────────────────────────────

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const currentMonth = new Date().toISOString().slice(0, 7);
  const selectedMonth = url.searchParams.get("month") || currentMonth;
  // Clamp to a real YYYY-MM format to prevent injection
  const safeMonth = /^\d{4}-\d{2}$/.test(selectedMonth) ? selectedMonth : currentMonth;

  const [plan, usageCount, contentStats, recentUsage, jobStats] = await Promise.all([
    getOrCreatePlan(shop),
    prisma.usageRecord.count({ where: { shop, month: safeMonth } }),
    prisma.generatedContent.groupBy({
      by: ["status"],
      where: { shop },
      _count: { status: true },
    }),
    prisma.usageRecord.groupBy({
      by: ["month"],
      where: { shop },
      _count: { month: true },
      orderBy: { month: "desc" },
      take: 6,
    }),
    prisma.generationJob.groupBy({
      by: ["status"],
      where: { shop },
      _count: { status: true },
    }),
  ]);

  const productCountResponse = await admin.graphql(`query { productsCount { count } }`);
  const productCountData = await productCountResponse.json();
  const totalProducts = productCountData.data.productsCount.count;

  const published = contentStats.find((s) => s.status === "published")?._count.status ?? 0;
  const draft = contentStats.find((s) => s.status === "draft")?._count.status ?? 0;
  const rejected = contentStats.find((s) => s.status === "rejected")?._count.status ?? 0;

  const coveragePct = totalProducts > 0 ? Math.round((published / totalProducts) * 100) : 0;

  const monthlyRows = recentUsage.map((r) => ({
    month: r.month,
    count: r._count.month,
  }));

  const completedJobs = jobStats.find((s) => s.status === "complete")?._count.status ?? 0;
  const failedJobs = jobStats.find((s) => s.status === "failed")?._count.status ?? 0;

  const daysInMonth = new Date(
    new Date().getFullYear(),
    new Date().getMonth() + 1,
    0
  ).getDate();
  const dayOfMonth = new Date().getDate();
  const daysRemaining = daysInMonth - dayOfMonth;

  // Build list of last 6 months for the selector
  const availableMonths = recentUsage.map((r) => r.month).sort().reverse();
  if (!availableMonths.includes(currentMonth)) availableMonths.unshift(currentMonth);

  return Response.json({
    totalProducts,
    published,
    draft,
    rejected,
    coveragePct,
    monthlyRows,
    completedJobs,
    failedJobs,
    plan: { planName: plan.planName, monthlyLimit: plan.monthlyLimit },
    usageCount,
    daysRemaining,
    selectedMonth: safeMonth,
    currentMonth,
    availableMonths,
  });
};

// ─── Component ───────────────────────────────────────────────────────────────

export default function AnalyticsPage() {
  const {
    totalProducts, published, draft, rejected, coveragePct,
    monthlyRows, completedJobs, failedJobs,
    plan, usageCount, daysRemaining, selectedMonth, currentMonth, availableMonths,
  } = useLoaderData();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const handleMonthChange = useCallback((month) => {
    setSearchParams({ month });
  }, [setSearchParams]);

  const usagePct = Math.min(100, Math.round((usageCount / plan.monthlyLimit) * 100));
  const planLabels = { free: "Free", starter: "Starter", growth: "Growth", pro: "Professional" };

  const tableRows = monthlyRows.map((r) => [
    r.month,
    r.count,
    <ProgressBar progress={Math.min(100, Math.round((r.count / plan.monthlyLimit) * 100))} size="small" />,
  ]);

  return (
    <Page
      title="Analytics"
      subtitle="Content performance and usage overview"
      backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
    >
      <BlockStack gap="500">
        {/* Summary stats */}
        <Layout>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">Content Coverage</Text>
                <Text as="p" variant="heading2xl" fontWeight="bold" tone={coveragePct >= 50 ? "success" : "critical"}>
                  {coveragePct}%
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  {published} of {totalProducts} products have published AI content
                </Text>
                <ProgressBar progress={coveragePct} tone={coveragePct >= 50 ? "success" : "critical"} size="small" />
              </BlockStack>
            </Card>
          </Layout.Section>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">Content Status</Text>
                <BlockStack gap="100">
                  <InlineStack align="space-between">
                    <Text as="p" variant="bodySm">Published</Text>
                    <Badge tone="success">{published}</Badge>
                  </InlineStack>
                  <InlineStack align="space-between">
                    <Text as="p" variant="bodySm">Drafts</Text>
                    <Badge tone="info">{draft}</Badge>
                  </InlineStack>
                  <InlineStack align="space-between">
                    <Text as="p" variant="bodySm">Rejected</Text>
                    <Badge>{rejected}</Badge>
                  </InlineStack>
                </BlockStack>
              </BlockStack>
            </Card>
          </Layout.Section>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">Bulk Jobs</Text>
                <InlineStack gap="300">
                  <BlockStack gap="100" inlineAlign="center">
                    <Text as="p" variant="heading2xl" fontWeight="bold" tone="success">{completedJobs}</Text>
                    <Text as="p" variant="bodySm" tone="subdued">Completed</Text>
                  </BlockStack>
                  <BlockStack gap="100" inlineAlign="center">
                    <Text as="p" variant="heading2xl" fontWeight="bold" tone="critical">{failedJobs}</Text>
                    <Text as="p" variant="bodySm" tone="subdued">Failed</Text>
                  </BlockStack>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        {/* Plan usage */}
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <InlineStack gap="200" blockAlign="center">
                <Text as="h2" variant="headingMd">Monthly Usage</Text>
                <Badge tone={plan.planName === "free" ? "attention" : "success"}>
                  {planLabels[plan.planName] ?? plan.planName} Plan
                </Badge>
              </InlineStack>
              <InlineStack gap="300" blockAlign="center">
                {selectedMonth === currentMonth && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {daysRemaining} days remaining
                  </Text>
                )}
                <Box minWidth="140px">
                  <Select
                    label="Month"
                    labelHidden
                    options={availableMonths.map((m) => ({ label: m, value: m }))}
                    value={selectedMonth}
                    onChange={handleMonthChange}
                  />
                </Box>
              </InlineStack>
            </InlineStack>
            <Text as="p" variant="bodySm" tone="subdued">
              {usageCount} / {plan.monthlyLimit} generations used
            </Text>
            <ProgressBar
              progress={usagePct}
              tone={usagePct >= 90 ? "critical" : usagePct >= 70 ? "highlight" : "success"}
              size="medium"
            />
          </BlockStack>
        </Card>

        {/* Monthly history table */}
        {monthlyRows.length > 0 && (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Generation History (last 6 months)</Text>
              <DataTable
                columnContentTypes={["text", "numeric", "text"]}
                headings={["Month", "Generations", "vs Plan Limit"]}
                rows={tableRows}
              />
            </BlockStack>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}
