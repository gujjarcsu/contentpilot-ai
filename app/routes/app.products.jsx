import { useLoaderData, useNavigate, useSubmit, redirect, useSearchParams, useNavigation } from "react-router";
import {
  Page,
  Layout,
  Card,
  ResourceList,
  ResourceItem,
  Text,
  Thumbnail,
  Badge,
  BlockStack,
  InlineStack,
  Button,
  EmptyState,
  Filters,
  Checkbox,
  Banner,
  Box,
  Tabs,
  Modal,
  SkeletonPage,
  SkeletonBodyText,
  SkeletonDisplayText,
  SkeletonThumbnail,
} from "@shopify/polaris";
import { useState, useCallback } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { enqueueGenerationJob } from "../queues/generationQueue.server";

const PAGE_SIZE = 50;

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor") || null;
  const direction = url.searchParams.get("dir") || "next";
  const statusFilter = url.searchParams.get("status") || "all";

  const query =
    direction === "prev"
      ? `query($cursor: String) {
          products(last: ${PAGE_SIZE}, before: $cursor, sortKey: TITLE) {
            pageInfo { hasPreviousPage hasNextPage startCursor endCursor }
            edges { node {
              id title handle status productType vendor description
              featuredImage { url altText }
              variants(first: 1) { edges { node { price } } }
              tags
            }}
          }
        }`
      : `query($cursor: String) {
          products(first: ${PAGE_SIZE}, after: $cursor, sortKey: TITLE) {
            pageInfo { hasPreviousPage hasNextPage startCursor endCursor }
            edges { node {
              id title handle status productType vendor description
              featuredImage { url altText }
              variants(first: 1) { edges { node { price } } }
              tags
            }}
          }
        }`;

  const response = await admin.graphql(query, { variables: { cursor } });
  const data = await response.json();
  const { edges, pageInfo } = data.data.products;
  const products = edges.map(({ node }) => ({
    id: node.id,
    numericId: node.id.replace("gid://shopify/Product/", ""),
    title: node.title,
    handle: node.handle,
    status: node.status,
    productType: node.productType,
    vendor: node.vendor,
    description: node.description || "",
    imageUrl: node.featuredImage?.url || "",
    imageAlt: node.featuredImage?.altText || "",
    price: node.variants.edges[0]?.node?.price || "0.00",
    tags: node.tags || [],
  }));

  // Get ALL content records for this shop to build the status map and tab counts
  const generatedProducts = await prisma.generatedContent.findMany({
    where: { shop, contentType: "description" },
    select: { productId: true, status: true, updatedAt: true },
  });

  const statusMap = {};
  generatedProducts.forEach(({ productId, status, updatedAt }) => {
    statusMap[productId] = { status, updatedAt };
  });

  // Tab counts from DB (global, not just this page)
  const dbCounts = { draft: 0, published: 0 };
  generatedProducts.forEach(({ status }) => {
    if (status === "draft") dbCounts.draft++;
    else if (status === "published") dbCounts.published++;
  });

  return Response.json({ products, statusMap, pageInfo, statusFilter, dbCounts });
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const actionType = formData.get("actionType") || "generateSelected";

  const contentTypes = ["description", "metaTitle", "metaDescription", "faq"].filter(
    (t) => formData.get(`bulk_${t}`) === "true"
  );
  if (contentTypes.length === 0) return { error: "Select at least one content type." };
  const autoPublish = formData.get("bulk_autoPublish") === "true";

  if (actionType === "generateAll") {
    // Paginate through ALL Shopify product IDs
    const allIds = [];
    let cursor = null;
    let hasNextPage = true;
    while (hasNextPage) {
      const resp = await admin.graphql(
        `query($cursor: String) {
          products(first: 250, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            edges { node { id } }
          }
        }`,
        { variables: { cursor } }
      );
      const { data } = await resp.json();
      const { edges, pageInfo } = data.products;
      allIds.push(...edges.map((e) => e.node.id));
      hasNextPage = pageInfo.hasNextPage;
      cursor = pageInfo.endCursor;
    }
    if (allIds.length === 0) return { error: "No products found in your store." };

    const job = await prisma.generationJob.create({
      data: {
        shop,
        status: "queued",
        totalProducts: allIds.length,
        productIds: JSON.stringify(allIds),
        contentTypes: contentTypes.join(","),
        autoPublish,
      },
    });
    await enqueueGenerationJob(job.id);
    return redirect("/app/jobs");
  }

  // generateSelected — existing bulk-by-selection flow
  let selectedIds;
  try {
    selectedIds = JSON.parse(formData.get("selectedIds") || "[]");
    if (!Array.isArray(selectedIds)) selectedIds = [];
  } catch {
    return { error: "Invalid selection data. Please refresh and try again." };
  }
  if (selectedIds.length === 0) return { error: "No products selected." };

  const job = await prisma.generationJob.create({
    data: {
      shop,
      status: "queued",
      totalProducts: selectedIds.length,
      productIds: JSON.stringify(selectedIds),
      contentTypes: contentTypes.join(","),
      autoPublish,
    },
  });
  await enqueueGenerationJob(job.id);
  return redirect("/app/jobs");
};

function ProductListSkeleton() {
  return (
    <SkeletonPage primaryAction>
      <Layout>
        {[1, 2, 3].map((i) => (
          <Layout.Section key={i} variant="oneThird">
            <Card>
              <BlockStack gap="300">
                <SkeletonDisplayText size="small" />
                <SkeletonBodyText lines={1} />
              </BlockStack>
            </Card>
          </Layout.Section>
        ))}
      </Layout>
      <Card>
        <BlockStack gap="400">
          {[1, 2, 3, 4, 5].map((i) => (
            <InlineStack key={i} gap="400" blockAlign="center">
              <SkeletonThumbnail size="medium" />
              <BlockStack gap="200">
                <SkeletonDisplayText size="small" />
                <SkeletonBodyText lines={1} />
              </BlockStack>
            </InlineStack>
          ))}
        </BlockStack>
      </Card>
    </SkeletonPage>
  );
}

export default function ProductsPage() {
  const { products, statusMap, pageInfo, statusFilter, dbCounts } = useLoaderData();
  const navigate = useNavigate();
  const submit = useSubmit();
  const navigation = useNavigation();
  const [, setSearchParams] = useSearchParams();

  const [searchValue, setSearchValue] = useState("");
  const [selectedItems, setSelectedItems] = useState([]);
  const [bulkDesc, setBulkDesc] = useState(true);
  const [bulkMeta, setBulkMeta] = useState(true);
  const [bulkFaq, setBulkFaq] = useState(false);
  const [bulkAutoPublish, setBulkAutoPublish] = useState(false);
  const [bulkError, setBulkError] = useState("");
  const [generateAllModal, setGenerateAllModal] = useState(false);

  const handleSearchChange = useCallback((v) => setSearchValue(v), []);
  const handleSearchClear = useCallback(() => setSearchValue(""), []);

  // Derived values (no hooks below this line — safe for early return)
  const tabFilteredProducts = products.filter((p) => {
    if (statusFilter === "draft") return statusMap[p.id]?.status === "draft";
    if (statusFilter === "published") return statusMap[p.id]?.status === "published";
    if (statusFilter === "needsContent") return !statusMap[p.id];
    return true; // "all"
  });

  const filteredProducts = tabFilteredProducts.filter((p) =>
    p.title.toLowerCase().includes(searchValue.toLowerCase())
  );

  const totalProducts = products.length;
  const publishedCount = Object.values(statusMap).filter((s) => s.status === "published").length;
  const draftCount = Object.values(statusMap).filter((s) => s.status === "draft").length;
  const noContentCount = totalProducts - publishedCount - draftCount;

  const tabs = [
    { id: "all", content: `All (${totalProducts})`, panelID: "all" },
    { id: "needsContent", content: `Needs Content (${noContentCount})`, panelID: "needsContent" },
    { id: "draft", content: `Draft (${dbCounts.draft})`, panelID: "draft" },
    { id: "published", content: `Published (${dbCounts.published})`, panelID: "published" },
  ];
  const selectedTabIndex = tabs.findIndex((t) => t.id === statusFilter);
  const activeTab = selectedTabIndex >= 0 ? selectedTabIndex : 0;

  const handleTabChange = useCallback(
    (index) => {
      const tabId = tabs[index].id;
      setSearchParams({ status: tabId });
      setSelectedItems([]);
    },
    [tabs, setSearchParams]
  );

  function getStatusBadge(productId) {
    const s = statusMap[productId];
    if (!s) return <Badge tone="attention">No AI Content</Badge>;
    if (s.status === "published") return <Badge tone="success">Published</Badge>;
    if (s.status === "draft") return <Badge tone="info">Draft Ready</Badge>;
    return <Badge>Unknown</Badge>;
  }

  function getContentPreview(product) {
    if (!product.description || product.description.length < 20) {
      return <Text as="p" variant="bodySm" tone="critical">Missing description</Text>;
    }
    return (
      <Text as="p" variant="bodySm" tone="subdued" truncate>
        {product.description.substring(0, 100)}…
      </Text>
    );
  }

  const buildBulkFormData = useCallback((actionType, ids) => {
    const fd = new FormData();
    fd.append("actionType", actionType);
    if (ids) fd.append("selectedIds", JSON.stringify(ids));
    fd.append("bulk_description", bulkDesc.toString());
    fd.append("bulk_metaTitle", bulkMeta.toString());
    fd.append("bulk_metaDescription", bulkMeta.toString());
    fd.append("bulk_faq", bulkFaq.toString());
    fd.append("bulk_autoPublish", bulkAutoPublish.toString());
    return fd;
  }, [bulkDesc, bulkMeta, bulkFaq, bulkAutoPublish]);

  const handleBulkGenerate = useCallback(() => {
    if (!bulkDesc && !bulkMeta && !bulkFaq) {
      setBulkError("Select at least one content type to generate.");
      return;
    }
    setBulkError("");
    submit(buildBulkFormData("generateSelected", selectedItems), { method: "POST" });
  }, [selectedItems, bulkDesc, bulkMeta, bulkFaq, buildBulkFormData, submit]);

  const handleGenerateAll = useCallback(() => {
    if (!bulkDesc && !bulkMeta && !bulkFaq) {
      setBulkError("Select at least one content type to generate.");
      return;
    }
    setBulkError("");
    setGenerateAllModal(false);
    submit(buildBulkFormData("generateAll", null), { method: "POST" });
  }, [bulkDesc, bulkMeta, bulkFaq, buildBulkFormData, setGenerateAllModal, submit]);

  if (navigation.state === "loading") return <ProductListSkeleton />;

  return (
    <Page
      title="Products"
      subtitle={`${totalProducts} products · ${publishedCount} optimised · ${noContentCount} need content`}
      backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
      secondaryActions={[
        {
          content: "Review Drafts",
          onAction: () => navigate("/app/review"),
          disabled: dbCounts.draft === 0,
        },
        {
          content: `Generate All (${totalProducts})`,
          onAction: () => setGenerateAllModal(true),
        },
        {
          content: "Bulk Jobs →",
          onAction: () => navigate("/app/jobs"),
        },
      ]}
    >
      <BlockStack gap="500">
        {/* Stats Bar */}
        <Layout>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="100">
                <Text as="p" variant="headingXl" fontWeight="bold" tone="success">{publishedCount}</Text>
                <Text as="p" variant="bodySm" tone="subdued">AI Content Published</Text>
              </BlockStack>
            </Card>
          </Layout.Section>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="100">
                <Text as="p" variant="headingXl" fontWeight="bold">{draftCount}</Text>
                <Text as="p" variant="bodySm" tone="subdued">Drafts to Review</Text>
              </BlockStack>
            </Card>
          </Layout.Section>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="100">
                <Text as="p" variant="headingXl" fontWeight="bold" tone="critical">{noContentCount}</Text>
                <Text as="p" variant="bodySm" tone="subdued">Need Content</Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        {/* Bulk generation panel */}
        {selectedItems.length > 0 && (
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Generate for {selectedItems.length} selected product{selectedItems.length > 1 ? "s" : ""}
                </Text>
                <Button variant="plain" tone="critical" onClick={() => setSelectedItems([])}>
                  Clear selection
                </Button>
              </InlineStack>

              {bulkError && <Banner tone="critical"><p>{bulkError}</p></Banner>}

              <InlineStack gap="500" wrap>
                <Checkbox
                  label="Description"
                  checked={bulkDesc}
                  onChange={setBulkDesc}
                  helpText="Full product description"
                />
                <Checkbox
                  label="Meta Title & Description"
                  checked={bulkMeta}
                  onChange={setBulkMeta}
                  helpText="SEO meta tags"
                />
                <Checkbox
                  label="FAQ Content"
                  checked={bulkFaq}
                  onChange={setBulkFaq}
                  helpText="Q&A pairs"
                />
                <Checkbox
                  label="Auto-publish"
                  checked={bulkAutoPublish}
                  onChange={setBulkAutoPublish}
                  helpText="Push to Shopify immediately — skips review"
                />
              </InlineStack>

              <InlineStack gap="300">
                <Button variant="primary" onClick={handleBulkGenerate}>
                  Generate {selectedItems.length} Product{selectedItems.length > 1 ? "s" : ""} →
                </Button>
                <Text as="p" variant="bodySm" tone="subdued">
                  ~{Math.ceil(selectedItems.length * 3.5 / 60)} min estimated · runs in background
                </Text>
              </InlineStack>
            </BlockStack>
          </Card>
        )}

        {/* Product List with status tabs */}
        <Card padding="0">
          <Tabs tabs={tabs} selected={activeTab} onSelect={handleTabChange} fitted />
          <ResourceList
            resourceName={{ singular: "product", plural: "products" }}
            items={filteredProducts}
            selectedItems={selectedItems}
            onSelectionChange={setSelectedItems}
            selectable
            filterControl={
              <Filters
                queryValue={searchValue}
                queryPlaceholder="Search products…"
                onQueryChange={handleSearchChange}
                onQueryClear={handleSearchClear}
                filters={[]}
                onClearAll={handleSearchClear}
              />
            }
            promotedBulkActions={[
              {
                content: `Generate for ${selectedItems.length} selected`,
                onAction: handleBulkGenerate,
              },
            ]}
            renderItem={(product) => {
              const { id, numericId, title, imageUrl, price, productType } = product;
              return (
                <ResourceItem
                  id={id}
                  media={
                    <Thumbnail
                      source={
                        imageUrl ||
                        "https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-product-1_large.png"
                      }
                      alt={title}
                      size="medium"
                    />
                  }
                  onClick={() => navigate(`/app/products/${numericId}`)}
                  shortcutActions={[
                    {
                      content: "Generate",
                      onAction: () => navigate(`/app/products/${numericId}`),
                    },
                  ]}
                >
                  <InlineStack align="space-between" blockAlign="center">
                    <BlockStack gap="100">
                      <Text as="h3" variant="bodyMd" fontWeight="bold">{title}</Text>
                      <InlineStack gap="200">
                        <Text as="span" variant="bodySm" tone="subdued">${price}</Text>
                        {productType && (
                          <Text as="span" variant="bodySm" tone="subdued">· {productType}</Text>
                        )}
                      </InlineStack>
                      {getContentPreview(product)}
                    </BlockStack>
                    <BlockStack gap="200" inlineAlign="end">
                      {getStatusBadge(id)}
                      <Button size="slim" onClick={() => navigate(`/app/products/${numericId}`)}>
                        Generate
                      </Button>
                    </BlockStack>
                  </InlineStack>
                </ResourceItem>
              );
            }}
            emptyState={
              <EmptyState
                heading={statusFilter === "all" ? "Your store is all caught up!" : `No ${statusFilter} products found`}
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                action={statusFilter !== "all" ? { content: "View all products", onAction: () => setSearchParams({}) } : undefined}
              >
                <p>
                  {statusFilter === "all"
                    ? "Looks like your store doesn't have any products yet. Add some products in Shopify, then come back here to generate killer content for them."
                    : `No products match the "${statusFilter}" filter. Try switching tabs or clearing the filter.`}
                </p>
              </EmptyState>
            }
          />
          {(pageInfo?.hasPreviousPage || pageInfo?.hasNextPage) && (
            <Box padding="400" borderBlockStartWidth="025" borderColor="border">
              <InlineStack align="center" gap="300">
                <Button
                  disabled={!pageInfo.hasPreviousPage}
                  onClick={() =>
                    setSearchParams({ cursor: pageInfo.startCursor, dir: "prev", status: statusFilter })
                  }
                >
                  ← Previous
                </Button>
                <Text as="p" variant="bodySm" tone="subdued">
                  Showing {filteredProducts.length} products
                </Text>
                <Button
                  disabled={!pageInfo.hasNextPage}
                  onClick={() =>
                    setSearchParams({ cursor: pageInfo.endCursor, dir: "next", status: statusFilter })
                  }
                >
                  Next →
                </Button>
              </InlineStack>
            </Box>
          )}
        </Card>

        {/* Generate All confirmation modal */}
        <Modal
          open={generateAllModal}
          onClose={() => setGenerateAllModal(false)}
          title={`Generate content for all ${totalProducts} products?`}
          primaryAction={{ content: "Start Bulk Job", onAction: handleGenerateAll }}
          secondaryActions={[{ content: "Cancel", onAction: () => setGenerateAllModal(false) }]}
        >
          <Modal.Section>
            <BlockStack gap="300">
              <Text as="p" variant="bodyMd">
                This creates a background job for all {totalProducts} products. Estimated time: ~{Math.ceil(totalProducts * 3.5 / 60)} minutes.
              </Text>
              <Text as="p" variant="bodySm" fontWeight="semibold">Content to generate:</Text>
              <Checkbox label="Description" checked={bulkDesc} onChange={setBulkDesc} />
              <Checkbox label="Meta Title & Description" checked={bulkMeta} onChange={setBulkMeta} />
              <Checkbox label="FAQ Content" checked={bulkFaq} onChange={setBulkFaq} />
              <Checkbox
                label="Auto-publish (skip review)"
                checked={bulkAutoPublish}
                onChange={setBulkAutoPublish}
                helpText="Pushes directly to Shopify — no review step"
              />
              {bulkError && <Banner tone="critical"><p>{bulkError}</p></Banner>}
            </BlockStack>
          </Modal.Section>
        </Modal>
      </BlockStack>
    </Page>
  );
}
