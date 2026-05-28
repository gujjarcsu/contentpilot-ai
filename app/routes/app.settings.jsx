import { useLoaderData, useActionData, useNavigation, useNavigate, Form } from "react-router";
import {
  Page, Layout, Card, Text, BlockStack, InlineStack,
  TextField, Select, Button, Banner, Box, Checkbox, Divider, Badge,
} from "@shopify/polaris";
import { useState, useEffect, useRef } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// ─── Loader ──────────────────────────────────────────────────────────────────

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [brandVoice, templates] = await Promise.all([
    prisma.brandVoice.findUnique({ where: { shop } }),
    prisma.contentTemplate.findMany({ where: { shop }, orderBy: { createdAt: "asc" } }),
  ]);

  return Response.json({
    brandVoice: brandVoice || {
      storeName: "", brandTone: "professional", targetAudience: "",
      keyDifferentiators: "", avoidPhrases: "", sampleContent: "",
      additionalNotes: "", targetKeywords: "", language: "en",
      autopilotEnabled: false, autopilotAutoPublish: false,
      autopilotContentTypes: "description,metaTitle,metaDescription",
    },
    templates,
  });
};

// ─── Action ──────────────────────────────────────────────────────────────────

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const actionType = formData.get("actionType") || "saveBrandVoice";

  const { invalidateCache } = await import("../utils/cache.server.js");

  if (actionType === "saveTemplate") {
    const name = (formData.get("tplName") || "").slice(0, 100).trim();
    if (!name) return Response.json({ error: "Template name is required." });
    const tplContentTypes = ["description", "metaTitle", "metaDescription", "faq"]
      .filter((t) => formData.get(`tpl_${t}`) === "true")
      .join(",") || "description,metaTitle,metaDescription";
    const isDefault = formData.get("tplDefault") === "true";
    // Clear existing defaults BEFORE creating so the new record is the only default.
    if (isDefault) {
      await prisma.contentTemplate.updateMany({
        where: { shop },
        data: { isDefault: false },
      });
    }
    await prisma.contentTemplate.create({
      data: {
        shop,
        name,
        contentLength: formData.get("tplLength") || "standard",
        contentTypes: tplContentTypes,
        keywords: (formData.get("tplKeywords") || "").slice(0, 500),
        customInstructions: (formData.get("tplInstructions") || "").slice(0, 1000),
        isDefault,
      },
    });
    return Response.json({ success: true, message: "Template saved!" });
  }

  if (actionType === "deleteTemplate") {
    const id = formData.get("templateId");
    await prisma.contentTemplate.deleteMany({ where: { id, shop } });
    return Response.json({ success: true, message: "Template deleted." });
  }

  // Default: save brand voice
  const VALID_TONES = new Set(["professional","friendly","premium","bold","scientific","warm","minimalist","playful","custom"]);
  const VALID_LANGUAGES = new Set(["en","es","fr","de","it","pt","ja","zh","ko","ar","hi","nl"]);

  const rawTone = formData.get("brandTone") || "professional";
  const rawLang = formData.get("language") || "en";

  const autopilotContentTypes = ["description", "metaTitle", "metaDescription", "faq"]
    .filter((t) => formData.get(`ap_${t}`) === "true")
    .join(",") || "description,metaTitle,metaDescription";

  const data = {
    storeName:            (formData.get("storeName") || "").slice(0, 200),
    brandTone:            VALID_TONES.has(rawTone) ? rawTone : "professional",
    targetAudience:       (formData.get("targetAudience") || "").slice(0, 500),
    keyDifferentiators:   (formData.get("keyDifferentiators") || "").slice(0, 500),
    avoidPhrases:         (formData.get("avoidPhrases") || "").slice(0, 500),
    sampleContent:        (formData.get("sampleContent") || "").slice(0, 5000),
    additionalNotes:      (formData.get("additionalNotes") || "").slice(0, 500),
    targetKeywords:       (formData.get("targetKeywords") || "").slice(0, 500),
    language:             VALID_LANGUAGES.has(rawLang) ? rawLang : "en",
    autopilotEnabled:     formData.get("autopilotEnabled") === "true",
    autopilotAutoPublish: formData.get("autopilotAutoPublish") === "true",
    autopilotContentTypes,
  };

  await prisma.brandVoice.upsert({
    where: { shop }, update: data, create: { shop, ...data },
  });

  await invalidateCache(`bv:${shop}`);
  return Response.json({ success: true, message: "Settings saved!" });
};

// ─── Component ───────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const { brandVoice, templates } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const isSaving = navigation.state === "submitting";

  const [storeName, setStoreName] = useState(brandVoice.storeName);
  const [brandTone, setBrandTone] = useState(brandVoice.brandTone);
  const [targetAudience, setTargetAudience] = useState(brandVoice.targetAudience);
  const [keyDifferentiators, setKeyDifferentiators] = useState(brandVoice.keyDifferentiators);
  const [avoidPhrases, setAvoidPhrases] = useState(brandVoice.avoidPhrases);
  const [sampleContent, setSampleContent] = useState(brandVoice.sampleContent);
  const [additionalNotes, setAdditionalNotes] = useState(brandVoice.additionalNotes);
  const [targetKeywords, setTargetKeywords] = useState(brandVoice.targetKeywords || "");
  const [language, setLanguage] = useState(brandVoice.language || "en");

  // Autopilot
  const [autopilotEnabled, setAutopilotEnabled] = useState(brandVoice.autopilotEnabled || false);
  const [autopilotAutoPublish, setAutopilotAutoPublish] = useState(brandVoice.autopilotAutoPublish || false);
  const apTypes = (brandVoice.autopilotContentTypes || "description,metaTitle,metaDescription").split(",");
  const [apDesc, setApDesc] = useState(apTypes.includes("description"));
  const [apMeta, setApMeta] = useState(apTypes.includes("metaTitle"));
  const [apFaq, setApFaq] = useState(apTypes.includes("faq"));

  // New template form
  const [tplName, setTplName] = useState("");
  const [tplLength, setTplLength] = useState("standard");
  const [tplDesc, setTplDesc] = useState(true);
  const [tplMeta, setTplMeta] = useState(true);
  const [tplFaq, setTplFaq] = useState(false);
  const [tplKeywords, setTplKeywords] = useState("");
  const [tplInstructions, setTplInstructions] = useState("");
  const [tplDefault, setTplDefault] = useState(false);

  const prevActionData = useRef(null);
  useEffect(() => {
    if (actionData && actionData !== prevActionData.current) {
      prevActionData.current = actionData;
      if (typeof window !== "undefined" && window.shopify?.toast) {
        if (actionData.success) {
          window.shopify.toast.show(actionData.message ?? "Saved!", { duration: 4000 });
        } else if (actionData.error) {
          window.shopify.toast.show(actionData.error, { duration: 5000, isError: true });
        }
      }
    }
  }, [actionData]);

  const toneOptions = [
    { label: "Professional & Trustworthy", value: "professional" },
    { label: "Friendly & Conversational", value: "friendly" },
    { label: "Premium & Luxurious", value: "premium" },
    { label: "Bold & Energetic", value: "bold" },
    { label: "Scientific & Technical", value: "scientific" },
    { label: "Warm & Nurturing", value: "warm" },
    { label: "Minimalist & Clean", value: "minimalist" },
    { label: "Fun & Playful", value: "playful" },
    { label: "Custom (describe in notes)", value: "custom" },
  ];
  const languageOptions = [
    { label: "English", value: "en" }, { label: "Spanish", value: "es" },
    { label: "French", value: "fr" }, { label: "German", value: "de" },
    { label: "Italian", value: "it" }, { label: "Portuguese", value: "pt" },
    { label: "Japanese", value: "ja" }, { label: "Chinese (Simplified)", value: "zh" },
    { label: "Korean", value: "ko" }, { label: "Arabic", value: "ar" },
    { label: "Hindi", value: "hi" }, { label: "Dutch", value: "nl" },
  ];
  const lengthOptions = [
    { label: "Short (~100-150 words)", value: "short" },
    { label: "Standard (~200-300 words)", value: "standard" },
    { label: "Detailed (~400-500 words)", value: "detailed" },
  ];

  return (
    <Page
      title="Settings"
      subtitle="Brand voice, autopilot, and content templates"
      backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
    >
      <BlockStack gap="500">
        {actionData?.success && (
          <Banner tone="success"><p>{actionData.message}</p></Banner>
        )}
        {actionData?.error && (
          <Banner tone="critical"><p>{actionData.error}</p></Banner>
        )}
        <Form method="post">
          <input type="hidden" name="actionType" value="saveBrandVoice" />
          {/* autopilot hidden fields */}
          <input type="hidden" name="autopilotEnabled" value={autopilotEnabled.toString()} />
          <input type="hidden" name="autopilotAutoPublish" value={autopilotAutoPublish.toString()} />
          <input type="hidden" name="ap_description" value={apDesc.toString()} />
          <input type="hidden" name="ap_metaTitle" value={apMeta.toString()} />
          <input type="hidden" name="ap_faq" value={apFaq.toString()} />

          <Layout>
            <Layout.Section>
              <BlockStack gap="400">
                {/* Store Identity */}
                <Card>
                  <BlockStack gap="400">
                    <Text as="h2" variant="headingLg">Store Identity</Text>
                    <TextField name="storeName" label="Store Name" value={storeName} onChange={setStoreName}
                      placeholder="e.g., Elite Peps Australia" autoComplete="off" />
                    <Select name="brandTone" label="Brand Tone" options={toneOptions}
                      value={brandTone} onChange={setBrandTone} />
                    <Select name="language" label="Content Language" options={languageOptions}
                      value={language} onChange={setLanguage} />
                    <TextField name="targetAudience" label="Target Audience" value={targetAudience}
                      onChange={setTargetAudience} multiline={3} autoComplete="off"
                      placeholder="e.g., Health-conscious Australians 25-55 into peptides" />
                  </BlockStack>
                </Card>

                {/* SEO Keywords */}
                <Card>
                  <BlockStack gap="400">
                    <Text as="h2" variant="headingLg">SEO Keyword Targeting</Text>
                    <TextField name="targetKeywords" label="Target Keywords" value={targetKeywords}
                      onChange={setTargetKeywords} autoComplete="off"
                      placeholder="e.g., peptides Australia, buy BPC-157"
                      helpText="Comma-separated. Woven into all content naturally." />
                  </BlockStack>
                </Card>

                {/* Differentiators */}
                <Card>
                  <BlockStack gap="400">
                    <Text as="h2" variant="headingLg">What Makes You Unique</Text>
                    <TextField name="keyDifferentiators" label="Key Differentiators"
                      value={keyDifferentiators} onChange={setKeyDifferentiators}
                      multiline={3} autoComplete="off"
                      placeholder="e.g., Australian lab tested, 99%+ purity, same-day dispatch" />
                    <TextField name="avoidPhrases" label="Phrases & Styles to Avoid"
                      value={avoidPhrases} onChange={setAvoidPhrases}
                      multiline={3} autoComplete="off"
                      placeholder="e.g., No hype words. No emojis. Never say 'revolutionary'." />
                  </BlockStack>
                </Card>

                {/* Sample Content */}
                <Card>
                  <BlockStack gap="400">
                    <Text as="h2" variant="headingLg">Train the AI on Your Voice</Text>
                    <TextField name="sampleContent" label="Your Best Product Descriptions (2-3 examples)"
                      value={sampleContent} onChange={setSampleContent} multiline={8} autoComplete="off"
                      placeholder="Paste your favourite product descriptions here…" />
                    <TextField name="additionalNotes" label="Additional Guidelines"
                      value={additionalNotes} onChange={setAdditionalNotes} multiline={3} autoComplete="off"
                      placeholder="e.g., Always mention we ship from Sydney. Never make medical claims." />
                  </BlockStack>
                </Card>

                {/* ── Autopilot ── */}
                <Card>
                  <BlockStack gap="400">
                    <InlineStack align="space-between" blockAlign="center">
                      <BlockStack gap="100">
                        <Text as="h2" variant="headingLg">Autopilot Mode</Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          Automatically generate content when a new product is added to your store.
                        </Text>
                      </BlockStack>
                      {autopilotEnabled && <Badge tone="success">Active</Badge>}
                    </InlineStack>

                    <Checkbox
                      label="Enable Autopilot"
                      checked={autopilotEnabled}
                      onChange={setAutopilotEnabled}
                      helpText="Requires the products/create webhook to be registered in your Shopify app."
                    />

                    {autopilotEnabled && (
                      <BlockStack gap="300">
                        <Divider />
                        <Text as="p" variant="bodySm" fontWeight="semibold">Content to auto-generate:</Text>
                        <InlineStack gap="400" wrap>
                          <Checkbox label="Description" checked={apDesc} onChange={setApDesc} />
                          <Checkbox label="Meta Title & Description" checked={apMeta} onChange={setApMeta} />
                          <Checkbox label="FAQ" checked={apFaq} onChange={setApFaq} />
                        </InlineStack>
                        <Checkbox
                          label="Auto-publish immediately (skip review)"
                          checked={autopilotAutoPublish}
                          onChange={setAutopilotAutoPublish}
                          helpText="Content goes live on Shopify without a review step"
                        />
                      </BlockStack>
                    )}
                  </BlockStack>
                </Card>

                <Button variant="primary" size="large" submit loading={isSaving} fullWidth>
                  {isSaving ? "Saving…" : "Save Settings"}
                </Button>
              </BlockStack>
            </Layout.Section>

            <Layout.Section variant="oneThird">
              <BlockStack gap="400">
                <Card>
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">Tips for Better Content</Text>
                    <Text as="p" variant="bodySm"><strong>Be specific with your audience.</strong> "Health-conscious Australian men 30-50" beats "everyone."</Text>
                    <Text as="p" variant="bodySm"><strong>Add real keywords.</strong> Woven naturally — no stuffing.</Text>
                    <Text as="p" variant="bodySm"><strong>Include real differentiators.</strong> "Lab tested with COA" beats "high quality."</Text>
                    <Text as="p" variant="bodySm"><strong>Paste real examples.</strong> The most powerful way to match your exact voice.</Text>
                  </BlockStack>
                </Card>
                <Card>
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">Flow Integration</Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Trigger content generation from Shopify Flow using the API endpoint:
                    </Text>
                    <Box padding="200" background="bg-surface-secondary" borderRadius="200">
                      <Text as="p" variant="bodySm">POST /api/generate</Text>
                      <Text as="p" variant="bodySm" tone="subdued">Header: X-ContentPilot-Token</Text>
                    </Box>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Contact support to enable the API endpoint.
                    </Text>
                  </BlockStack>
                </Card>
              </BlockStack>
            </Layout.Section>
          </Layout>
        </Form>

        {/* ── Re-run wizard ── */}
        <Card>
          <InlineStack align="space-between" blockAlign="center">
            <BlockStack gap="100">
              <Text as="h2" variant="headingMd">Brand Voice Setup Wizard</Text>
              <Text as="p" variant="bodySm" tone="subdued">Re-run the guided setup to update your brand voice settings.</Text>
            </BlockStack>
            <Button onClick={() => navigate("/app/setup")}>Re-run onboarding wizard →</Button>
          </InlineStack>
        </Card>

        {/* ── Content Templates ── */}
        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center">
              <BlockStack gap="100">
                <Text as="h2" variant="headingLg">Content Templates</Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Save generation presets — apply them from the product page with one click.
                </Text>
              </BlockStack>
            </InlineStack>

            {templates.length > 0 && (
              <BlockStack gap="200">
                {templates.map((tpl) => (
                  <Box key={tpl.id} padding="300" background="bg-surface-secondary" borderRadius="200">
                    <InlineStack align="space-between" blockAlign="center">
                      <BlockStack gap="100">
                        <InlineStack gap="200" blockAlign="center">
                          <Text as="p" variant="bodyMd" fontWeight="semibold">{tpl.name}</Text>
                          {tpl.isDefault && <Badge tone="success">Default</Badge>}
                        </InlineStack>
                        <Text as="p" variant="bodySm" tone="subdued">
                          {tpl.contentLength} · {tpl.contentTypes.replace(/,/g, ", ")}
                          {tpl.keywords && ` · keywords: ${tpl.keywords}`}
                        </Text>
                      </BlockStack>
                      <Form method="post">
                        <input type="hidden" name="actionType" value="deleteTemplate" />
                        <input type="hidden" name="templateId" value={tpl.id} />
                        <Button tone="critical" variant="plain" size="slim" submit>Delete</Button>
                      </Form>
                    </InlineStack>
                  </Box>
                ))}
              </BlockStack>
            )}

            <Divider />
            <Text as="h3" variant="headingMd">Add New Template</Text>

            <Form method="post">
              <input type="hidden" name="actionType" value="saveTemplate" />
              <input type="hidden" name="tpl_description" value={tplDesc.toString()} />
              <input type="hidden" name="tpl_metaTitle" value={tplMeta.toString()} />
              <input type="hidden" name="tpl_faq" value={tplFaq.toString()} />
              <input type="hidden" name="tplDefault" value={tplDefault.toString()} />
              <BlockStack gap="300">
                <TextField name="tplName" label="Template Name" value={tplName} onChange={setTplName}
                  placeholder="e.g., Full SEO Package" autoComplete="off" />
                <Select name="tplLength" label="Description Length" options={lengthOptions}
                  value={tplLength} onChange={setTplLength} />
                <Text as="p" variant="bodySm" fontWeight="semibold">Content types:</Text>
                <InlineStack gap="400" wrap>
                  <Checkbox label="Description" checked={tplDesc} onChange={setTplDesc} />
                  <Checkbox label="Meta Title & Description" checked={tplMeta} onChange={setTplMeta} />
                  <Checkbox label="FAQ" checked={tplFaq} onChange={setTplFaq} />
                </InlineStack>
                <TextField name="tplKeywords" label="Keywords (optional)" value={tplKeywords}
                  onChange={setTplKeywords} autoComplete="off" placeholder="Override global keywords" />
                <TextField name="tplInstructions" label="Custom Instructions (optional)"
                  value={tplInstructions} onChange={setTplInstructions} multiline={2} autoComplete="off"
                  placeholder="e.g., Focus on clinical applications, always mention purity" />
                <Checkbox label="Set as default template" checked={tplDefault} onChange={setTplDefault} />
                <Button submit loading={isSaving} disabled={!tplName.trim()}>Save Template</Button>
              </BlockStack>
            </Form>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
