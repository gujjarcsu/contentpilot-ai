import { useLoaderData, useFetcher, useNavigate, useRevalidator } from "react-router";
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
  Box,
  Banner,
  Checkbox,
  Spinner,
  Divider,
  TextField,
  Select,
} from "@shopify/polaris";
import { useState, useEffect, useRef, useCallback } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// ─── Loader ──────────────────────────────────────────────────────────────────

export async function loader({ request, params }) {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const productId = `gid://shopify/Product/${params.id}`;

  const response = await admin.graphql(
    `query getProduct($id: ID!) {
      product(id: $id) {
        id title handle status productType vendor
        description descriptionHtml
        seo { title description }
        featuredImage { url altText }
        images(first: 10) { edges { node { id url altText } } }
        variants(first: 10) { edges { node { title price sku } } }
        tags
      }
    }`,
    { variables: { id: productId } }
  );

  const { data } = await response.json();
  if (!data.product) throw new Response("Product not found", { status: 404 });
  const product = data.product;

  const [existingContent, brandVoice] = await Promise.all([
    prisma.generatedContent.findMany({ where: { shop, productId }, orderBy: { updatedAt: "desc" } }),
    prisma.brandVoice.findUnique({ where: { shop } }),
  ]);

  return {
    product: {
      id: product.id,
      title: product.title,
      handle: product.handle,
      status: product.status || "ACTIVE",
      productType: product.productType,
      vendor: product.vendor,
      description: product.description || "",
      descriptionHtml: product.descriptionHtml || "",
      seoTitle: product.seo?.title || "",
      seoDescription: product.seo?.description || "",
      imageUrl: product.featuredImage?.url || "",
      imageAlt: product.featuredImage?.altText || "",
      images: product.images.edges.map((e) => ({
        id: e.node.id,
        url: e.node.url,
        altText: e.node.altText || "",
      })),
      variants: product.variants.edges.map((e) => ({
        title: e.node.title,
        price: e.node.price,
        sku: e.node.sku,
      })),
      tags: product.tags || [],
    },
    existingContent: existingContent.reduce((acc, item) => {
      acc[item.contentType] = {
        generated: item.generatedContent,
        original: item.originalContent,
        status: item.status,
        version: item.version,
        id: item.id,
      };
      return acc;
    }, {}),
    hasBrandVoice: !!brandVoice,
    hasApiKey: !!process.env.ANTHROPIC_API_KEY,
  };
}

// ─── Action ──────────────────────────────────────────────────────────────────

export async function action({ request, params }) {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const productId = `gid://shopify/Product/${params.id}`;
  const formData = await request.formData();
  const actionType = formData.get("actionType");

  // Dynamic imports keep server-only modules out of the client bundle
  const [
    { generateProductContent, generateAltText },
    { tryConsumeGeneration },
    { checkRateLimit },
    { getCache },
  ] = await Promise.all([
    import("../utils/ai.server.js"),
    import("../utils/plans.server.js"),
    import("../utils/rateLimit.server.js"),
    import("../utils/cache.server.js"),
  ]);

  // ── Generate ──────────────────────────────────────────────────────────────
  if (actionType === "generate") {
    const rl = await checkRateLimit(shop, { maxPerMinute: 10 });
    if (!rl.allowed) {
      return { error: `Too many requests. Please wait ${rl.retryAfterSeconds} seconds before generating again.` };
    }

    const contentTypes = ["description", "metaTitle", "metaDescription", "faq"].filter(
      (t) => formData.get(`gen_${t}`) === "true"
    );
    const doAltText = formData.get("gen_altText") === "true";
    const autoPublish = formData.get("autoPublish") === "true";
    const targetKeywords = (formData.get("targetKeywords") || "").trim();
    const contentLength = formData.get("contentLength") || "standard";

    if (contentTypes.length === 0 && !doAltText) {
      return { error: "Select at least one content type to generate." };
    }

    const primaryContentType = contentTypes[0] ?? "altText";
    const gate = await tryConsumeGeneration(shop, primaryContentType, productId);
    if (!gate.allowed) {
      return {
        error: `Monthly limit reached (${gate.monthlyLimit} generations on the ${gate.planName} plan). Upgrade your plan to continue.`,
        limitReached: true,
      };
    }

    const productResponse = await admin.graphql(
      `query getProduct($id: ID!) {
        product(id: $id) {
          title productType vendor description descriptionHtml
          seo { title description }
          featuredImage { url }
          images(first: 10) { edges { node { id url } } }
          variants(first: 10) { edges { node { title price } } }
          tags
        }
      }`,
      { variables: { id: productId } }
    );
    const { data: productData } = await productResponse.json();
    const product = productData.product;

    const brandVoice = await getCache(
      `bv:${shop}`,
      () => prisma.brandVoice.findUnique({ where: { shop } }),
      300
    );

    let generated = {};
    if (contentTypes.length > 0) {
      generated = await generateProductContent(
        {
          title: product.title,
          productType: product.productType,
          vendor: product.vendor,
          description: product.description,
          descriptionHtml: product.descriptionHtml,
          imageUrl: product.featuredImage?.url || "",
          variants: product.variants.edges.map((e) => e.node),
          tags: product.tags,
        },
        brandVoice,
        contentTypes,
        { keywords: targetKeywords, length: contentLength }
      );

      const finalStatus = autoPublish ? "published" : "draft";
      await Promise.all(
        contentTypes
          .filter((t) => generated[t])
          .map((type) => {
            const originalContent =
              type === "description" ? product.descriptionHtml || "" :
              type === "metaTitle" ? product.seo?.title || "" :
              type === "metaDescription" ? product.seo?.description || "" : "";
            return prisma.generatedContent.upsert({
              where: { shop_productId_contentType: { shop, productId, contentType: type } },
              update: { generatedContent: generated[type], originalContent, status: finalStatus, version: { increment: 1 } },
              create: { shop, productId, productTitle: product.title, contentType: type, originalContent, generatedContent: generated[type], status: finalStatus },
            });
          })
      );

      // Auto-publish: immediately push to Shopify
      if (autoPublish) {
        const input = { id: productId };
        if (generated.description) input.descriptionHtml = generated.description;
        if (generated.metaTitle || generated.metaDescription) {
          input.seo = {};
          if (generated.metaTitle) input.seo.title = generated.metaTitle;
          if (generated.metaDescription) input.seo.description = generated.metaDescription;
        }
        if (Object.keys(input).length > 1) {
          await admin.graphql(
            `mutation updateProduct($input: ProductInput!) {
              productUpdate(input: $input) {
                product { id }
                userErrors { field message }
              }
            }`,
            { variables: { input } }
          );
        }
      }
    }

    let altTextResults = [];
    if (doAltText) {
      const images = product.images.edges.map((e) => e.node).filter((img) => img.url);
      if (images.length > 0) {
        for (const img of images) {
          try {
            const altText = await generateAltText(img.url, product.title);
            const mutResult = await admin.graphql(
              `mutation productImageUpdate($productId: ID!, $image: ImageInput!) {
                productImageUpdate(productId: $productId, image: $image) {
                  image { id altText }
                  userErrors { field message }
                }
              }`,
              { variables: { productId, image: { id: img.id, altText } } }
            );
            const { data: mutData } = await mutResult.json();
            const errors = mutData?.productImageUpdate?.userErrors ?? [];
            if (errors.length > 0) {
              altTextResults.push({ imageId: img.id, url: img.url, altText, error: errors[0].message });
            } else {
              altTextResults.push({ imageId: img.id, url: img.url, altText });
            }
          } catch (err) {
            altTextResults.push({ imageId: img.id, url: img.url, altText: "", error: err.message });
          }
        }

        await prisma.generatedContent.upsert({
          where: { shop_productId_contentType: { shop, productId, contentType: "altText" } },
          update: { generatedContent: JSON.stringify(altTextResults), status: "published", version: { increment: 1 } },
          create: { shop, productId, productTitle: product.title, contentType: "altText", originalContent: "", generatedContent: JSON.stringify(altTextResults), status: "published" },
        });
      }
    }

    const messageParts = [];
    if (contentTypes.length > 0) {
      messageParts.push(
        autoPublish
          ? "Content generated and published to your store!"
          : "Content generated — review below and publish when ready."
      );
    }
    if (doAltText && altTextResults.length > 0) {
      const succeeded = altTextResults.filter((r) => !r.error).length;
      messageParts.push(`Alt text applied to ${succeeded} image${succeeded !== 1 ? "s" : ""}.`);
    }

    return { success: true, generated, altTextResults, autoPublished: autoPublish, message: messageParts.join(" ") || "Done!" };
  }

  // ── Publish (with optional edited content) ────────────────────────────────
  if (actionType === "publish") {
    const description = formData.get("publishDescription");
    const metaTitle = formData.get("publishMetaTitle");
    const metaDescription = formData.get("publishMetaDescription");

    const input = { id: productId };
    if (description) input.descriptionHtml = description;
    if (metaTitle || metaDescription) {
      input.seo = {};
      if (metaTitle) input.seo.title = metaTitle;
      if (metaDescription) input.seo.description = metaDescription;
    }

    const mutationResult = await admin.graphql(
      `mutation updateProduct($input: ProductInput!) {
        productUpdate(input: $input) {
          product { id }
          userErrors { field message }
        }
      }`,
      { variables: { input } }
    );

    const { data: mutationData } = await mutationResult.json();
    const userErrors = mutationData?.productUpdate?.userErrors ?? [];
    if (userErrors.length > 0) {
      const msg = userErrors.map((e) => (e.field ? `${e.field}: ${e.message}` : e.message)).join("; ");
      return { error: `Shopify rejected the update — ${msg}. Nothing was published.` };
    }

    const publishedTypes = [];
    if (description) publishedTypes.push("description");
    if (metaTitle) publishedTypes.push("metaTitle");
    if (metaDescription) publishedTypes.push("metaDescription");
    if (publishedTypes.length > 0) {
      await prisma.generatedContent.updateMany({
        where: { shop, productId, contentType: { in: publishedTypes }, status: "draft" },
        data: { status: "published" },
      });
    }

    // Write FAQ JSON-LD as a metafield so Liquid themes can embed structured data
    const faqRecord = await prisma.generatedContent.findUnique({
      where: { shop_productId_contentType: { shop, productId, contentType: "faq" } },
    });
    if (faqRecord?.generatedContent) {
      const { faqToJsonLd } = await import("../utils/seo.server.js");
      const jsonLd = faqToJsonLd(faqRecord.generatedContent);
      if (jsonLd) {
        await admin.graphql(
          `mutation setMetafields($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              metafields { id }
              userErrors { field message }
            }
          }`,
          {
            variables: {
              metafields: [{
                ownerId: productId,
                namespace: "contentpilot",
                key: "faq_schema",
                type: "json",
                value: JSON.stringify(jsonLd),
              }],
            },
          }
        );
      }
    }

    return { success: true, published: true, message: "Content published to your Shopify store!" };
  }

  // ── Revert ────────────────────────────────────────────────────────────────
  if (actionType === "revert") {
    const contentType = formData.get("contentType");
    const existing = await prisma.generatedContent.findUnique({
      where: { shop_productId_contentType: { shop, productId, contentType } },
    });
    if (!existing?.originalContent) {
      return { error: "No original content saved to revert to." };
    }
    await prisma.generatedContent.update({
      where: { shop_productId_contentType: { shop, productId, contentType } },
      data: { generatedContent: existing.originalContent, status: "draft" },
    });
    return { success: true, reverted: true, contentType, message: `${contentType} reverted to original content.` };
  }

  return { error: "Unknown action." };
}

// ─── Component ───────────────────────────────────────────────────────────────

function OriginalContentSection({ original, contentType, revertFetcher }) {
  const [expanded, setExpanded] = useState(false);
  if (!original) return null;
  const isReverting =
    revertFetcher.state !== "idle" && revertFetcher.formData?.get("contentType") === contentType;

  return (
    <BlockStack gap="200">
      <Button variant="plain" onClick={() => setExpanded((v) => !v)}>
        {expanded ? "Hide original" : "Show original content"}
      </Button>
      {expanded && (
        <Box padding="300" background="bg-surface-secondary" borderRadius="200">
          <BlockStack gap="200">
            <Text as="p" variant="bodySm" fontWeight="bold" tone="subdued">ORIGINAL (before AI):</Text>
            {contentType === "description" ? (
              <div dangerouslySetInnerHTML={{ __html: original || "(empty)" }} />
            ) : (
              <Text as="p" variant="bodySm">{original || "(empty)"}</Text>
            )}
            {original && (
              <revertFetcher.Form method="post">
                <input type="hidden" name="actionType" value="revert" />
                <input type="hidden" name="contentType" value={contentType} />
                <Button variant="plain" tone="critical" size="slim" submit loading={isReverting}>
                  Revert to this original
                </Button>
              </revertFetcher.Form>
            )}
          </BlockStack>
        </Box>
      )}
    </BlockStack>
  );
}

export default function ProductGeneratePage() {
  const { product, existingContent, hasBrandVoice, hasApiKey } = useLoaderData();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const fetcher = useFetcher();
  const revertFetcher = useFetcher();
  const prevFetcherData = useRef(null);
  const prevRevertData = useRef(null);

  const isLoading = fetcher.state !== "idle";
  const actionData = fetcher.data;
  const isGenerating = isLoading && fetcher.formData?.get("actionType") === "generate";
  const isPublishing = isLoading && fetcher.formData?.get("actionType") === "publish";

  // Generate panel state
  const [genDescription, setGenDescription] = useState(true);
  const [genMetaTitle, setGenMetaTitle] = useState(true);
  const [genMetaDescription, setGenMetaDescription] = useState(true);
  const [genFaq, setGenFaq] = useState(false);
  const [genAltText, setGenAltText] = useState(false);
  const [autoPublish, setAutoPublish] = useState(false);
  const [targetKeywords, setTargetKeywords] = useState("");
  const [contentLength, setContentLength] = useState("standard");

  // Editable content state — initialized from generated or existing
  const rawDescription = actionData?.generated?.description || existingContent.description?.generated || "";
  const rawMetaTitle = actionData?.generated?.metaTitle || existingContent.metaTitle?.generated || "";
  const rawMetaDescription = actionData?.generated?.metaDescription || existingContent.metaDescription?.generated || "";
  const faq = actionData?.generated?.faq || existingContent.faq?.generated || "";

  const [editedDescription, setEditedDescription] = useState(rawDescription);
  const [editedMetaTitle, setEditedMetaTitle] = useState(rawMetaTitle);
  const [editedMetaDescription, setEditedMetaDescription] = useState(rawMetaDescription);

  // Sync edited state when new content arrives
  useEffect(() => {
    if (rawDescription) setEditedDescription(rawDescription);
  }, [rawDescription]);
  useEffect(() => {
    if (rawMetaTitle) setEditedMetaTitle(rawMetaTitle);
  }, [rawMetaTitle]);
  useEffect(() => {
    if (rawMetaDescription) setEditedMetaDescription(rawMetaDescription);
  }, [rawMetaDescription]);

  const hasGeneratedContent = !!(rawDescription || rawMetaTitle || rawMetaDescription || faq);

  const altTextResults = actionData?.altTextResults ?? (() => {
    const raw = existingContent.altText?.generated;
    try { return raw ? JSON.parse(raw) : []; } catch { return []; }
  })();

  // Toast on success
  useEffect(() => {
    if (actionData?.success && actionData !== prevFetcherData.current) {
      prevFetcherData.current = actionData;
      if (typeof window !== "undefined" && window.shopify?.toast) {
        window.shopify.toast.show(actionData.message ?? "Done!", { duration: 4000 });
      }
    }
  }, [actionData]);

  // Revalidate after revert
  useEffect(() => {
    if (revertFetcher.data?.reverted && revertFetcher.data !== prevRevertData.current) {
      prevRevertData.current = revertFetcher.data;
      if (typeof window !== "undefined" && window.shopify?.toast) {
        window.shopify.toast.show(revertFetcher.data.message ?? "Reverted.", { duration: 3000 });
      }
      if (revalidator.state === "idle") revalidator.revalidate();
    }
  }, [revertFetcher.data, revalidator]);

  const handleGenerate = useCallback((overrideTypes = null) => {
    const fd = new FormData();
    fd.append("actionType", "generate");
    const types = overrideTypes || {
      description: genDescription,
      metaTitle: genMetaTitle,
      metaDescription: genMetaDescription,
      faq: genFaq,
      altText: genAltText,
    };
    fd.append("gen_description", (types.description ?? false).toString());
    fd.append("gen_metaTitle", (types.metaTitle ?? false).toString());
    fd.append("gen_metaDescription", (types.metaDescription ?? false).toString());
    fd.append("gen_faq", (types.faq ?? false).toString());
    fd.append("gen_altText", (types.altText ?? false).toString());
    fd.append("autoPublish", autoPublish.toString());
    fd.append("targetKeywords", targetKeywords);
    fd.append("contentLength", contentLength);
    fetcher.submit(fd, { method: "POST" });
  }, [genDescription, genMetaTitle, genMetaDescription, genFaq, genAltText, autoPublish, targetKeywords, contentLength, fetcher]);

  const handleRegenerateSection = useCallback((type) => {
    const types = { description: false, metaTitle: false, metaDescription: false, faq: false, altText: false };
    types[type] = true;
    handleGenerate(types);
  }, [handleGenerate]);

  const handlePublish = useCallback(() => {
    const fd = new FormData();
    fd.append("actionType", "publish");
    if (editedDescription) fd.append("publishDescription", editedDescription);
    if (editedMetaTitle) fd.append("publishMetaTitle", editedMetaTitle);
    if (editedMetaDescription) fd.append("publishMetaDescription", editedMetaDescription);
    fetcher.submit(fd, { method: "POST" });
  }, [editedDescription, editedMetaTitle, editedMetaDescription, fetcher]);

  const noneSelected = !genDescription && !genMetaTitle && !genMetaDescription && !genFaq && !genAltText;
  const noImages = product.images.length === 0;

  const lengthOptions = [
    { label: "Short (~100-150 words) — simple products", value: "short" },
    { label: "Standard (~200-300 words) — default", value: "standard" },
    { label: "Detailed (~400-500 words) — complex/high-value products", value: "detailed" },
  ];

  return (
    <Page
      title={product.title}
      backAction={{ content: "Products", onAction: () => navigate("/app/products") }}
    >
      <BlockStack gap="500">
        {actionData?.error && (
          <Banner tone="critical" title="Error">
            <p>{actionData.error}</p>
            {actionData.limitReached && (
              <Box paddingBlockStart="200">
                <Button variant="plain" onClick={() => navigate("/app/plans")}>
                  View Plans & Billing →
                </Button>
              </Box>
            )}
          </Banner>
        )}
        {revertFetcher.data?.error && (
          <Banner tone="critical"><p>{revertFetcher.data.error}</p></Banner>
        )}
        {!hasApiKey && (
          <Banner tone="critical" title="API Key Missing">
            <p>Add ANTHROPIC_API_KEY to your .env file to enable content generation.</p>
          </Banner>
        )}
        {!hasBrandVoice && (
          <Banner tone="warning">
            <p>
              No brand voice configured — content will use a default tone.{" "}
              <Button variant="plain" onClick={() => navigate("/app/settings")}>
                Set up brand voice →
              </Button>
            </p>
          </Banner>
        )}

        <Layout>
          {/* ── Left: product info + controls ─────────────────────────────── */}
          <Layout.Section variant="oneThird">
            <BlockStack gap="400">
              <Card>
                <BlockStack gap="300">
                  {product.imageUrl && (
                    <Thumbnail source={product.imageUrl} alt={product.title} size="large" />
                  )}
                  <Text as="h2" variant="headingMd">{product.title}</Text>
                  <InlineStack gap="200">
                    <Badge>{product.status}</Badge>
                    {product.productType && <Badge tone="info">{product.productType}</Badge>}
                  </InlineStack>
                  <Text as="p" variant="bodySm" tone="subdued">
                    ${product.variants[0]?.price || "0.00"} · {product.vendor || "No vendor"}
                  </Text>
                  {product.tags.length > 0 && (
                    <Text as="p" variant="bodySm" tone="subdued">
                      Tags: {product.tags.join(", ")}
                    </Text>
                  )}
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">Generate Content</Text>

                  <Select
                    label="Description Length"
                    options={lengthOptions}
                    value={contentLength}
                    onChange={setContentLength}
                  />

                  <TextField
                    label="Target Keywords (optional)"
                    value={targetKeywords}
                    onChange={setTargetKeywords}
                    placeholder="e.g., peptides Australia, BPC-157"
                    helpText="Overrides global keywords for this product"
                    autoComplete="off"
                  />

                  <Text as="p" variant="bodySm" tone="subdued">Select what to generate:</Text>
                  <Checkbox
                    label="Product Description"
                    checked={genDescription}
                    onChange={setGenDescription}
                    helpText="Full description with SEO optimisation"
                  />
                  <Checkbox
                    label="Meta Title"
                    checked={genMetaTitle}
                    onChange={setGenMetaTitle}
                    helpText="SEO title tag (max 60 characters)"
                  />
                  <Checkbox
                    label="Meta Description"
                    checked={genMetaDescription}
                    onChange={setGenMetaDescription}
                    helpText="SEO meta description (max 155 characters)"
                  />
                  <Checkbox
                    label="FAQ Content"
                    checked={genFaq}
                    onChange={setGenFaq}
                    helpText="4–5 questions and answers"
                  />
                  <Checkbox
                    label="Image Alt Text"
                    checked={genAltText}
                    onChange={setGenAltText}
                    disabled={noImages}
                    helpText={
                      noImages
                        ? "No images on this product"
                        : `Applied directly to ${product.images.length} image${product.images.length !== 1 ? "s" : ""}`
                    }
                  />

                  <Divider />

                  <Checkbox
                    label="Auto-publish after generation"
                    checked={autoPublish}
                    onChange={setAutoPublish}
                    helpText="Skips the review step — publishes immediately to Shopify"
                  />

                  <Button
                    variant="primary"
                    size="large"
                    onClick={() => handleGenerate()}
                    loading={isGenerating}
                    disabled={isLoading || noneSelected || !hasApiKey}
                    fullWidth
                  >
                    {isGenerating ? "Generating with AI…" : "Generate Content"}
                  </Button>
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>

          {/* ── Right: content preview + inline editing ───────────────────── */}
          <Layout.Section>
            <BlockStack gap="400">

              {/* Description */}
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">Product Description</Text>
                    {rawDescription && (
                      <Button size="slim" variant="plain" onClick={() => handleRegenerateSection("description")} loading={isGenerating}>
                        Regenerate
                      </Button>
                    )}
                  </InlineStack>

                  <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                    <BlockStack gap="100">
                      <Text as="p" variant="bodySm" fontWeight="bold" tone="subdued">CURRENT:</Text>
                      {product.descriptionHtml ? (
                        <span dangerouslySetInnerHTML={{ __html: product.descriptionHtml.substring(0, 500) }} />
                      ) : (
                        <Text as="p" tone="critical">No description — this product needs content.</Text>
                      )}
                    </BlockStack>
                  </Box>

                  {isGenerating && (
                    <Box padding="400">
                      <InlineStack align="center" gap="200">
                        <Spinner size="small" />
                        <Text as="p" variant="bodyMd">Generating… this takes 10–20 seconds</Text>
                      </InlineStack>
                    </Box>
                  )}

                  {rawDescription && (
                    <BlockStack gap="200">
                      <InlineStack align="space-between">
                        <Text as="p" variant="bodySm" fontWeight="bold" tone="success">AI-GENERATED (editable):</Text>
                        <Badge tone={existingContent.description?.status === "published" ? "success" : "info"}>
                          {existingContent.description?.status === "published" ? "Published" : "Draft"}
                        </Badge>
                      </InlineStack>
                      <TextField
                        label=""
                        labelHidden
                        value={editedDescription}
                        onChange={setEditedDescription}
                        multiline={8}
                        helpText="Edit the HTML directly — changes are saved when you click Publish"
                        autoComplete="off"
                      />
                    </BlockStack>
                  )}

                  {!rawDescription && !isGenerating && (
                    <Text as="p" variant="bodySm" tone="subdued">
                      Click "Generate Content" to create an AI-optimised description.
                    </Text>
                  )}

                  {existingContent.description?.original && (
                    <>
                      <Divider />
                      <OriginalContentSection
                        original={existingContent.description.original}
                        contentType="description"
                        revertFetcher={revertFetcher}
                      />
                    </>
                  )}
                </BlockStack>
              </Card>

              {/* Meta Title */}
              {(rawMetaTitle || genMetaTitle) && (
                <Card>
                  <BlockStack gap="200">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h2" variant="headingMd">Meta Title</Text>
                      {rawMetaTitle && (
                        <Button size="slim" variant="plain" onClick={() => handleRegenerateSection("metaTitle")} loading={isGenerating}>
                          Regenerate
                        </Button>
                      )}
                    </InlineStack>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Current: {product.seoTitle || "(using product title)"}
                    </Text>
                    {rawMetaTitle && (
                      <BlockStack gap="100">
                        <TextField
                          label=""
                          labelHidden
                          value={editedMetaTitle}
                          onChange={setEditedMetaTitle}
                          helpText={`${editedMetaTitle.length}/60 characters`}
                          error={editedMetaTitle.length > 60 ? "Over 60 characters — shorten before publishing" : ""}
                          autoComplete="off"
                        />
                      </BlockStack>
                    )}
                    {existingContent.metaTitle?.original && (
                      <>
                        <Divider />
                        <OriginalContentSection
                          original={existingContent.metaTitle.original}
                          contentType="metaTitle"
                          revertFetcher={revertFetcher}
                        />
                      </>
                    )}
                  </BlockStack>
                </Card>
              )}

              {/* Meta Description */}
              {(rawMetaDescription || genMetaDescription) && (
                <Card>
                  <BlockStack gap="200">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h2" variant="headingMd">Meta Description</Text>
                      {rawMetaDescription && (
                        <Button size="slim" variant="plain" onClick={() => handleRegenerateSection("metaDescription")} loading={isGenerating}>
                          Regenerate
                        </Button>
                      )}
                    </InlineStack>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Current: {product.seoDescription || "(none set)"}
                    </Text>
                    {rawMetaDescription && (
                      <TextField
                        label=""
                        labelHidden
                        value={editedMetaDescription}
                        onChange={setEditedMetaDescription}
                        multiline={2}
                        helpText={`${editedMetaDescription.length}/155 characters`}
                        error={editedMetaDescription.length > 155 ? "Over 155 characters — shorten before publishing" : ""}
                        autoComplete="off"
                      />
                    )}
                    {existingContent.metaDescription?.original && (
                      <>
                        <Divider />
                        <OriginalContentSection
                          original={existingContent.metaDescription.original}
                          contentType="metaDescription"
                          revertFetcher={revertFetcher}
                        />
                      </>
                    )}
                  </BlockStack>
                </Card>
              )}

              {/* FAQ */}
              {faq && (
                <Card>
                  <BlockStack gap="200">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h2" variant="headingMd">FAQ Content</Text>
                      <Button size="slim" variant="plain" onClick={() => handleRegenerateSection("faq")} loading={isGenerating}>
                        Regenerate
                      </Button>
                    </InlineStack>
                    <Box padding="200" background="bg-surface-success" borderRadius="200">
                      <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", margin: 0 }}>{faq}</pre>
                    </Box>
                    {existingContent.faq?.original && (
                      <>
                        <Divider />
                        <OriginalContentSection
                          original={existingContent.faq.original}
                          contentType="faq"
                          revertFetcher={revertFetcher}
                        />
                      </>
                    )}
                  </BlockStack>
                </Card>
              )}

              {/* Image Alt Text */}
              {(altTextResults.length > 0 || genAltText) && (
                <Card>
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h2" variant="headingMd">Image Alt Text</Text>
                      <Badge tone="success">Applied to Shopify</Badge>
                    </InlineStack>
                    {isGenerating && genAltText && (
                      <InlineStack gap="200">
                        <Spinner size="small" />
                        <Text as="p" variant="bodySm" tone="subdued">
                          Generating alt text for {product.images.length} image{product.images.length !== 1 ? "s" : ""}…
                        </Text>
                      </InlineStack>
                    )}
                    {altTextResults.length > 0 && (
                      <BlockStack gap="300">
                        {altTextResults.map((result, i) => (
                          <Box key={result.imageId ?? i} padding="200" background="bg-surface-secondary" borderRadius="200">
                            <InlineStack gap="300" blockAlign="start">
                              <Thumbnail source={result.url} alt="" size="small" />
                              <BlockStack gap="100">
                                {result.error ? (
                                  <Text as="p" variant="bodySm" tone="critical">Error: {result.error}</Text>
                                ) : (
                                  <>
                                    <Text as="p" variant="bodySm" fontWeight="semibold">{result.altText}</Text>
                                    <Text as="p" variant="bodySm" tone="subdued">{result.altText.length} characters</Text>
                                  </>
                                )}
                              </BlockStack>
                            </InlineStack>
                          </Box>
                        ))}
                      </BlockStack>
                    )}
                    {!altTextResults.length && !isGenerating && (
                      <Text as="p" variant="bodySm" tone="subdued">
                        Check "Image Alt Text" and click Generate to create alt text for all images.
                      </Text>
                    )}
                  </BlockStack>
                </Card>
              )}

              {/* Publish button */}
              {hasGeneratedContent && !actionData?.autoPublished && (
                <Card>
                  <BlockStack gap="200">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Your edits above will be published — not the original AI output.
                    </Text>
                    <Button
                      variant="primary"
                      size="large"
                      onClick={handlePublish}
                      loading={isPublishing}
                      disabled={isLoading}
                      fullWidth
                    >
                      {isPublishing ? "Publishing…" : "Publish to Store"}
                    </Button>
                  </BlockStack>
                </Card>
              )}
            </BlockStack>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
