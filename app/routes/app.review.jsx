import { useLoaderData, useActionData, useNavigation, useNavigate, useSubmit } from "react-router";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Button,
  Thumbnail,
  Badge,
  Banner,
  Checkbox,
  EmptyState,
  TextField,
  Box,
  Divider,
} from "@shopify/polaris";
import { useState, useCallback } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// ─── Loader ──────────────────────────────────────────────────────────────────

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  // Fetch all draft GeneratedContent records for this shop
  const drafts = await prisma.generatedContent.findMany({
    where: { shop, status: "draft" },
    orderBy: { updatedAt: "desc" },
  });

  if (drafts.length === 0) return Response.json({ products: [] });

  // Group by productId
  const byProduct = {};
  for (const d of drafts) {
    if (!byProduct[d.productId]) {
      byProduct[d.productId] = {
        productId: d.productId,
        productTitle: d.productTitle || d.productId,
        content: {},
      };
    }
    byProduct[d.productId].content[d.contentType] = d.generatedContent;
  }

  // Batch-fetch product info from Shopify
  const productIds = Object.keys(byProduct);
  const shopifyData = await fetchProductsBatch(admin, productIds);

  // Merge Shopify data into our grouped records
  const products = productIds.map((pid) => {
    const info = shopifyData[pid] || {};
    return {
      ...byProduct[pid],
      productTitle: info.title || byProduct[pid].productTitle,
      imageUrl: info.imageUrl || "",
    };
  });

  return Response.json({ products });
};

async function fetchProductsBatch(admin, productIds) {
  if (productIds.length === 0) return {};
  const idsJson = JSON.stringify(productIds);
  const response = await admin.graphql(
    `query getNodes($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product {
          id
          title
          featuredImage { url altText }
        }
      }
    }`,
    { variables: { ids: productIds } }
  );
  const { data } = await response.json();
  const result = {};
  for (const node of data?.nodes ?? []) {
    if (node?.id) {
      result[node.id] = {
        title: node.title,
        imageUrl: node.featuredImage?.url || "",
      };
    }
  }
  return result;
}

// ─── Action ──────────────────────────────────────────────────────────────────

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const actionType = formData.get("actionType");

  if (actionType === "publish") {
    let approved;
    let edits = {};
    try {
      approved = JSON.parse(formData.get("approved") || "[]");
      edits = JSON.parse(formData.get("edits") || "{}");
    } catch {
      return Response.json({ error: "Invalid submission data." }, { status: 400 });
    }
    if (!Array.isArray(approved) || approved.length === 0) {
      return Response.json({ error: "No products approved for publishing." }, { status: 400 });
    }

    // Fetch draft content for each approved product
    const draftRecords = await prisma.generatedContent.findMany({
      where: { shop, productId: { in: approved }, status: "draft" },
    });

    const byProduct = {};
    for (const r of draftRecords) {
      if (!byProduct[r.productId]) byProduct[r.productId] = {};
      byProduct[r.productId][r.contentType] = r.generatedContent;
    }

    let published = 0;
    let failed = 0;
    const errors = [];

    for (const productId of approved) {
      // Merge DB drafts with any inline edits (edits take precedence)
      const content = { ...byProduct[productId], ...edits[productId] };
      const input = { id: productId };
      if (content.description) input.descriptionHtml = content.description;
      if (content.metaTitle || content.metaDescription) {
        input.seo = {};
        if (content.metaTitle) input.seo.title = content.metaTitle;
        if (content.metaDescription) input.seo.description = content.metaDescription;
      }

      try {
        const result = await admin.graphql(
          `mutation updateProduct($input: ProductInput!) {
            productUpdate(input: $input) {
              product { id }
              userErrors { field message }
            }
          }`,
          { variables: { input } }
        );
        const { data } = await result.json();
        const userErrors = data?.productUpdate?.userErrors ?? [];
        if (userErrors.length > 0) {
          failed++;
          errors.push({ productId, error: userErrors.map((e) => e.message).join("; ") });
        } else {
          // Mark published content types
          const publishedTypes = Object.keys(content).filter((t) =>
            ["description", "metaTitle", "metaDescription", "faq"].includes(t)
          );
          if (publishedTypes.length > 0) {
            await prisma.generatedContent.updateMany({
              where: { shop, productId, contentType: { in: publishedTypes }, status: "draft" },
              data: { status: "published" },
            });
          }
          published++;
        }
      } catch (err) {
        failed++;
        errors.push({ productId, error: err.message });
      }
    }

    return Response.json({
      success: true,
      published,
      failed,
      errors,
      message: `Published content for ${published} product${published !== 1 ? "s" : ""}${failed > 0 ? `, ${failed} failed` : ""}.`,
    });
  }

  if (actionType === "reject") {
    let rejected;
    try {
      rejected = JSON.parse(formData.get("rejected") || "[]");
    } catch {
      return Response.json({ error: "Invalid rejection data." }, { status: 400 });
    }
    if (Array.isArray(rejected) && rejected.length > 0) {
      await prisma.generatedContent.updateMany({
        where: { shop, productId: { in: rejected }, status: "draft" },
        data: { status: "rejected" },
      });
    }
    return Response.json({ success: true, message: `${rejected.length} product(s) marked as rejected.` });
  }

  return Response.json({ error: "Unknown action." }, { status: 400 });
};

// ─── Component ───────────────────────────────────────────────────────────────

export default function ReviewPage() {
  const { products } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const submit = useSubmit();
  const isSubmitting = navigation.state === "submitting";

  const [approved, setApproved] = useState(() => new Set(products.map((p) => p.productId)));
  const [search, setSearch] = useState("");
  // edits: { [productId]: { [contentType]: editedValue } }
  const [edits, setEdits] = useState({});

  const handleEdit = useCallback((productId, type, value) => {
    setEdits((prev) => ({
      ...prev,
      [productId]: { ...prev[productId], [type]: value },
    }));
  }, []);

  const toggleApproved = useCallback((productId) => {
    setApproved((prev) => {
      const next = new Set(prev);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setApproved(new Set(products.map((p) => p.productId)));
  }, [products]);

  const deselectAll = useCallback(() => setApproved(new Set()), []);

  const handlePublish = useCallback(() => {
    const fd = new FormData();
    fd.append("actionType", "publish");
    fd.append("approved", JSON.stringify([...approved]));
    fd.append("edits", JSON.stringify(edits));
    submit(fd, { method: "POST" });
  }, [approved, edits, submit]);

  const handleRejectUnapproved = useCallback(() => {
    const rejectedIds = products
      .map((p) => p.productId)
      .filter((id) => !approved.has(id));
    if (rejectedIds.length === 0) return;
    const fd = new FormData();
    fd.append("actionType", "reject");
    fd.append("rejected", JSON.stringify(rejectedIds));
    submit(fd, { method: "POST" });
  }, [products, approved, submit]);

  const filtered = products.filter((p) =>
    p.productTitle.toLowerCase().includes(search.toLowerCase())
  );

  const approvedCount = [...approved].filter((id) =>
    products.some((p) => p.productId === id)
  ).length;

  if (products.length === 0) {
    return (
      <Page
        title="Review & Publish"
        backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
      >
        <EmptyState
          heading="No drafts waiting for review"
          image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
          action={{ content: "Generate Content", onAction: () => navigate("/app/products") }}
        >
          <p>Generate content for your products, then come back here to review and publish everything at once.</p>
        </EmptyState>
      </Page>
    );
  }

  return (
    <Page
      title="Review & Publish"
      subtitle={`${products.length} product${products.length !== 1 ? "s" : ""} with draft content ready to review`}
      backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
    >
      <BlockStack gap="500">
        {actionData?.success && (
          <Banner tone="success" title="Done!">
            <p>{actionData.message}</p>
            {actionData.errors?.map((e, i) => (
              <p key={i} style={{ marginTop: 4 }}>
                Failed: {e.productId} — {e.error}
              </p>
            ))}
          </Banner>
        )}
        {actionData?.error && (
          <Banner tone="critical"><p>{actionData.error}</p></Banner>
        )}

        {/* Action bar */}
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <InlineStack gap="300" blockAlign="center">
                <Text as="p" variant="bodyMd" fontWeight="semibold">
                  {approvedCount} of {products.length} approved
                </Text>
                <Button variant="plain" size="slim" onClick={selectAll}>Select All</Button>
                <Button variant="plain" size="slim" onClick={deselectAll}>Deselect All</Button>
              </InlineStack>
              <InlineStack gap="200">
                <Button
                  variant="plain"
                  tone="critical"
                  size="slim"
                  onClick={handleRejectUnapproved}
                  loading={isSubmitting && navigation.formData?.get("actionType") === "reject"}
                  disabled={isSubmitting}
                >
                  Reject Unapproved
                </Button>
                <Button
                  variant="primary"
                  onClick={handlePublish}
                  loading={isSubmitting && navigation.formData?.get("actionType") === "publish"}
                  disabled={isSubmitting || approvedCount === 0}
                >
                  Publish {approvedCount} Approved →
                </Button>
              </InlineStack>
            </InlineStack>

            <TextField
              label=""
              labelHidden
              placeholder="Search products…"
              value={search}
              onChange={setSearch}
              clearButton
              onClearButtonClick={() => setSearch("")}
              autoComplete="off"
            />
          </BlockStack>
        </Card>

        {/* Product cards */}
        <BlockStack gap="400">
          {filtered.map((product) => (
            <ProductReviewCard
              key={product.productId}
              product={product}
              isApproved={approved.has(product.productId)}
              onToggle={() => toggleApproved(product.productId)}
              onEdit={(type, value) => handleEdit(product.productId, type, value)}
            />
          ))}
        </BlockStack>

        {/* Bottom publish button */}
        {filtered.length > 3 && (
          <Card>
            <InlineStack align="end">
              <Button
                variant="primary"
                size="large"
                onClick={handlePublish}
                loading={isSubmitting && navigation.formData?.get("actionType") === "publish"}
                disabled={isSubmitting || approvedCount === 0}
              >
                Publish {approvedCount} Approved →
              </Button>
            </InlineStack>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}

function ProductReviewCard({ product, isApproved, onToggle, onEdit }) {
  const [expanded, setExpanded] = useState({});
  const toggleExpand = (type) =>
    setExpanded((prev) => ({ ...prev, [type]: !prev[type] }));

  const contentTypes = ["description", "metaTitle", "metaDescription", "faq"].filter(
    (t) => product.content[t]
  );

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <InlineStack gap="300" blockAlign="center">
            <Thumbnail
              source={
                product.imageUrl ||
                "https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-product-1_large.png"
              }
              alt={product.productTitle}
              size="medium"
            />
            <BlockStack gap="100">
              <Text as="h3" variant="headingMd">{product.productTitle}</Text>
              <InlineStack gap="200">
                {contentTypes.map((t) => (
                  <Badge key={t} tone="info">{t}</Badge>
                ))}
              </InlineStack>
            </BlockStack>
          </InlineStack>
          <Checkbox
            label={isApproved ? "Approved" : "Skipped"}
            checked={isApproved}
            onChange={onToggle}
          />
        </InlineStack>

        <Divider />

        {contentTypes.map((type) => (
          <ContentSection
            key={type}
            type={type}
            content={product.content[type]}
            expanded={!!expanded[type]}
            onToggle={() => toggleExpand(type)}
            onEdit={(value) => onEdit(type, value)}
          />
        ))}
      </BlockStack>
    </Card>
  );
}

function ContentSection({ type, content, expanded, onToggle, onEdit }) {
  const [editedValue, setEditedValue] = useState(content);

  const labels = {
    description: "Description",
    metaTitle: "Meta Title",
    metaDescription: "Meta Description",
    faq: "FAQ",
  };

  const handleChange = useCallback((value) => {
    setEditedValue(value);
    onEdit(value);
  }, [onEdit]);

  const preview =
    type === "description"
      ? content.replace(/<[^>]+>/g, "").substring(0, 120) + "…"
      : content.substring(0, 120) + (content.length > 120 ? "…" : "");

  const charLimit = type === "metaTitle" ? 60 : type === "metaDescription" ? 155 : null;
  const charCount = editedValue.length;
  const overLimit = charLimit && charCount > charLimit;

  return (
    <BlockStack gap="200">
      <InlineStack align="space-between" blockAlign="center">
        <Text as="p" variant="bodySm" fontWeight="semibold">{labels[type] || type}</Text>
        <Button variant="plain" size="slim" onClick={onToggle}>
          {expanded ? "Collapse" : "Edit"}
        </Button>
      </InlineStack>
      {expanded ? (
        <BlockStack gap="100">
          <TextField
            label=""
            labelHidden
            value={editedValue}
            onChange={handleChange}
            multiline={type === "description" ? 8 : type === "faq" ? 6 : 2}
            helpText={charLimit ? `${charCount}/${charLimit} characters${overLimit ? " — too long" : ""}` : "Edit before publishing"}
            error={overLimit ? `Shorten to under ${charLimit} characters` : ""}
            autoComplete="off"
          />
        </BlockStack>
      ) : (
        <Text as="p" variant="bodySm" tone="subdued">{preview}</Text>
      )}
    </BlockStack>
  );
}
