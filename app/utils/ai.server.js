import logger from "./logger.server.js";
import { getProductTypeInstructions, getLanguageName } from "./seo.server.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_RETRIES = 2;

/**
 * Generate product content using Claude.
 *
 * options:
 *   keywords    – comma-separated keyword targets (per-product override)
 *   length      – "short" | "standard" | "detailed"
 *   language    – ISO 639-1 code from brandVoice settings
 */
export async function generateProductContent(
  product,
  brandVoice,
  contentTypes = ["description", "metaTitle", "metaDescription"],
  options = {}
) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured.");

  const prompt = buildPrompt(product, brandVoice, contentTypes, options);

  // Collect up to 4 images for vision context
  const imageUrls = [];
  if (Array.isArray(product.images) && product.images.length > 0) {
    product.images.slice(0, 4).forEach((img) => {
      const url = img?.url || img?.src;
      if (url) imageUrls.push(url);
    });
  } else if (product.imageUrl) {
    imageUrls.push(product.imageUrl);
  }

  const messageContent = imageUrls.length > 0
    ? [
        ...imageUrls.map((url) => ({ type: "image", source: { type: "url", url } })),
        { type: "text", text: prompt },
      ]
    : prompt;

  const rawText = await callClaude(apiKey, {
    model: "claude-sonnet-4-6",
    max_tokens: 4000,
    messages: [{ role: "user", content: messageContent }],
  });

  return parseGeneratedContent(rawText);
}

export async function generateAltText(imageUrl, productTitle) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured.");

  const rawText = await callClaude(apiKey, {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 200,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "url", url: imageUrl } },
          {
            type: "text",
            text: `Write concise alt text for this product image. Product: "${productTitle}". Rules: under 125 chars, describe what is visually shown, include the product name naturally, helpful for accessibility and SEO, do NOT start with "Image of" or "Photo of". Return ONLY the alt text.`,
          },
        ],
      },
    ],
  });

  return rawText.trim();
}

export async function generateBlogPost(topic, brandVoice, options = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured.");

  const { keywords = "", length = "medium", tone = brandVoice?.brandTone || "professional" } = options;
  const wordCounts = { short: "500-700", medium: "900-1100", long: "1800-2200" };
  const targetWords = wordCounts[length] || wordCounts.medium;
  const language = brandVoice?.language || "en";
  const langName = getLanguageName(language);

  const prompt = `You are writing a blog post for an e-commerce store.

=== BRAND CONTEXT ===
Store Name: ${brandVoice?.storeName || "the store"}
Brand Tone: ${tone}
Target Audience: ${brandVoice?.targetAudience || "general consumers"}
Key Differentiators: ${brandVoice?.keyDifferentiators || ""}
${brandVoice?.sampleContent ? `\nSAMPLE WRITING STYLE (match this):\n${brandVoice.sampleContent}` : ""}

=== BLOG POST BRIEF ===
Topic: ${topic}
${keywords ? `Target Keywords: ${keywords} — use these naturally throughout the post` : ""}
Length: ${targetWords} words
Language: Write entirely in ${langName}

=== INSTRUCTIONS ===
Write a compelling, SEO-friendly blog post on the given topic.
- Engaging headline (H1)
- Introduction that hooks the reader in the first 2 sentences
- Well-structured body with H2 subheadings
- Practical, valuable content the target audience will share
- Natural keyword usage — do NOT keyword-stuff
- Conclusion with a clear next step or call to action
- Write in the brand tone — do NOT make the brand voice robotic or AI-sounding
- HTML formatting: use <h1>, <h2>, <p>, <ul><li>, <strong> tags

=== OUTPUT FORMAT ===
<BLOG_TITLE>The blog post title</BLOG_TITLE>
<BLOG_CONTENT>Full HTML blog post content here</BLOG_CONTENT>`;

  const rawText = await callClaude(apiKey, {
    model: "claude-sonnet-4-6",
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt }],
  });

  return {
    title: extractTag(rawText, "BLOG_TITLE"),
    content: extractTag(rawText, "BLOG_CONTENT"),
  };
}

export async function generateCollectionDescription(collection, brandVoice, options = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured.");

  const language = brandVoice?.language || "en";
  const langName = getLanguageName(language);
  const keywords = options.keywords || brandVoice?.targetKeywords || "";

  const prompt = `You are writing content for a Shopify collection page.

=== BRAND CONTEXT ===
Store Name: ${brandVoice?.storeName || "the store"}
Brand Tone: ${brandVoice?.brandTone || "professional"}
Target Audience: ${brandVoice?.targetAudience || "general consumers"}
Key Differentiators: ${brandVoice?.keyDifferentiators || ""}
${brandVoice?.sampleContent ? `\nSAMPLE WRITING STYLE (match this):\n${brandVoice.sampleContent}` : ""}

=== COLLECTION DATA ===
Collection Title: ${collection.title}
Product Count: ${collection.productsCount ?? "multiple"} products
Current Description: ${collection.description || "None"}
${collection.seoTitle ? `Current SEO Title: ${collection.seoTitle}` : ""}
${keywords ? `\nTarget Keywords: ${keywords}` : ""}

=== INSTRUCTIONS ===
This is a COLLECTION page, not a single product. Write compelling content that:
- Introduces the category and what shoppers will find here
- Highlights key products or sub-categories if relevant
- Guides the shopper toward a purchase decision
- Includes relevant keywords naturally
- Language: Write entirely in ${langName}

Generate:
<DESCRIPTION>HTML collection description (100-200 words)</DESCRIPTION>
<META_TITLE>SEO meta title (max 60 chars)</META_TITLE>
<META_DESCRIPTION>SEO meta description (max 155 chars)</META_DESCRIPTION>`;

  const rawText = await callClaude(apiKey, {
    model: "claude-sonnet-4-6",
    max_tokens: 1500,
    messages: [{ role: "user", content: prompt }],
  });

  return {
    description: extractTag(rawText, "DESCRIPTION"),
    metaTitle: extractTag(rawText, "META_TITLE"),
    metaDescription: extractTag(rawText, "META_DESCRIPTION"),
  };
}

// ─── Internal helpers ────────────────────────────────────────────────────────

async function callClaude(apiKey, body, attempt = 0) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const t0 = Date.now();

  let response;
  try {
    response = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      logger.error({ model: body.model, attempt }, "Claude API request timed out");
      throw new Error("Claude API timed out after 45 seconds.");
    }
    logger.error({ err, model: body.model, attempt }, "Claude API fetch error");
    throw err;
  }
  clearTimeout(timer);

  if (response.ok) {
    const data = await response.json();
    logger.debug({ model: body.model, attempt, ms: Date.now() - t0 }, "Claude API call succeeded");
    return data.content[0]?.text ?? "";
  }

  if (response.status >= 500 && attempt < MAX_RETRIES) {
    logger.warn({ model: body.model, status: response.status, attempt }, "Claude API 5xx — retrying");
    await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
    return callClaude(apiKey, body, attempt + 1);
  }

  const errorBody = await response.text();
  logger.error({ model: body.model, status: response.status, attempt, body: errorBody }, "Claude API error");
  throw new Error(`Claude API error ${response.status}: ${errorBody}`);
}

function buildPrompt(product, brandVoice, contentTypes, options = {}) {
  const sections = [];
  const keywords = options.keywords || brandVoice?.targetKeywords || "";
  const language = brandVoice?.language || "en";
  const langName = getLanguageName(language);
  const length = options.length || "standard";

  const wordCounts = { short: "100-150", standard: "200-300", detailed: "400-500" };
  const targetWordCount = wordCounts[length] || wordCounts.standard;

  // ── Anti-hallucination anchor ─────────────────────────────────────────────
  sections.push(`=== CRITICAL RULES — READ FIRST ===
FACTUAL ACCURACY: Only state factual claims that appear verbatim in the PRODUCT DATA or BRAND CONTEXT sections below. Never invent certifications, manufacturing origins, testing claims, awards, country of origin, or specific statistics. Generic benefits ("great gift", "long-lasting") are acceptable; specific claims ("made in Australia", "lab tested", "certified organic") are NOT unless explicitly provided.
VOICE: Write as the brand, not about it. First or second person where natural.
AUTHENTICITY: Do not mention AI, automation, or content generation.`);

  // ── Language ─────────────────────────────────────────────────────────────
  if (language !== "en") {
    sections.push(`=== LANGUAGE ===
Write ALL content in ${langName}. The meta title and meta description must also be in ${langName}. Maintain natural, native-sounding ${langName} — do not translate literally from English.`);
  }

  // ── Brand context ─────────────────────────────────────────────────────────
  sections.push(`=== BRAND CONTEXT ===
Store Name: ${brandVoice?.storeName || "the store"}
Brand Tone: ${brandVoice?.brandTone || "professional and helpful"}
Target Audience: ${brandVoice?.targetAudience || "general consumers"}
Key Differentiators: ${brandVoice?.keyDifferentiators || "quality products, great service"}
Phrases/Styles to Avoid: ${brandVoice?.avoidPhrases || "generic AI-sounding language, excessive hype"}
Additional Guidelines: ${brandVoice?.additionalNotes || "none"}${brandVoice?.sampleContent ? `\n\nSAMPLE CONTENT IN OUR VOICE (match this writing style exactly):\n${brandVoice.sampleContent}` : ""}`);

  // ── Product type awareness ────────────────────────────────────────────────
  const typeNote = getProductTypeInstructions(product.productType, product.title);
  if (typeNote) {
    sections.push(`=== PRODUCT TYPE NOTE ===\n${typeNote}`);
  }

  // ── SEO keywords ──────────────────────────────────────────────────────────
  if (keywords && keywords.trim()) {
    sections.push(`=== SEO KEYWORD TARGETS ===
Primary keywords to naturally incorporate: ${keywords}
Use these keywords in the product description (at least 2-3 natural occurrences), the meta title, and meta description. Do NOT keyword-stuff — integrate them naturally into the copy.`);
  }

  // ── Price range ───────────────────────────────────────────────────────────
  const prices = (product.variants || [])
    .map((v) => parseFloat(v.price))
    .filter((p) => !isNaN(p));
  const priceInfo =
    prices.length > 1
      ? `Price Range: $${Math.min(...prices).toFixed(2)} – $${Math.max(...prices).toFixed(2)}`
      : prices.length === 1
      ? `Price: $${prices[0].toFixed(2)}`
      : "Price: N/A";

  // ── Product data ──────────────────────────────────────────────────────────
  sections.push(`=== PRODUCT DATA ===
Title: ${product.title}
Product Type: ${product.productType || "N/A"}
Vendor: ${product.vendor || "N/A"}
Tags: ${product.tags?.join(", ") || "none"}
${priceInfo}
Variants: ${product.variants?.map((v) => v.title).filter((t) => t !== "Default Title").join(", ") || "Single option"}
Current Description: ${product.descriptionHtml || product.description || "No existing description"}${product.imageUrl ? "\n\nPRODUCT IMAGE: Provided above. Use visual details you observe (colors, materials, form, packaging, context) to enrich the description. Only describe what is visibly present." : ""}`);

  // ── Content type instructions ─────────────────────────────────────────────
  const typeInstructions = [];

  if (contentTypes.includes("description")) {
    typeInstructions.push(`
PRODUCT DESCRIPTION:
- Write a compelling product description of ${targetWordCount} words
- Structure: (1) hook that addresses a real customer pain point or desire, (2) body with specific features and tangible benefits, (3) clear call to action
- Include emotional appeal — help the customer visualise owning and using this product
- Consistent brand tone throughout; natural keyword usage for SEO
- HTML formatting: <p> tags for paragraphs, <strong> for key highlights, <ul><li> for feature lists
- Strictly target the ${targetWordCount} word range — expand or tighten accordingly
- Format: <DESCRIPTION>your HTML content here</DESCRIPTION>`);
  }

  if (contentTypes.includes("metaTitle")) {
    typeInstructions.push(`
META TITLE:
- SEO-optimised, maximum 60 characters (strictly enforce)
- Format: Brand Name Product Name | Key Benefit or Category
- CAPITALISATION: Use Title Case for significant words
- Make it compelling and relevant to search intent
- Format: <META_TITLE>Your Title Here</META_TITLE>`);
  }

  if (contentTypes.includes("metaDescription")) {
    typeInstructions.push(`
META DESCRIPTION:
- SEO-optimised, maximum 155 characters (strictly enforce)
- Clear value proposition with a subtle call to action
- CAPITALISATION: Sentence case — first word and proper nouns only
- Format: <META_DESCRIPTION>Your meta description here.</META_DESCRIPTION>`);
  }

  if (contentTypes.includes("faq")) {
    typeInstructions.push(`
FAQ CONTENT:
- 4–5 questions real customers would ask about usage, benefits, materials, shipping, compatibility, or suitability
- Each answer 2–3 sentences — helpful, specific, and grounded in the product data
- Do NOT invent claims not supported by the product data
- Format:
<FAQ>
Q: Question here?
A: Answer here.

Q: Question here?
A: Answer here.
</FAQ>`);
  }

  sections.push(`=== CONTENT TO GENERATE ===${typeInstructions.join("\n")}`);

  sections.push(`=== OUTPUT RULES ===
- Match the brand tone exactly in every sentence — read the SAMPLE CONTENT above and mirror that rhythm and register
- No filler openers: never start with "Whether you're looking for...", "Say goodbye to...", "Introducing...", "Are you tired of..."
- Every sentence must earn its place — no padding
- Re-read the CRITICAL RULES at the top before finalising your output`);

  return sections.join("\n\n");
}

function parseGeneratedContent(rawText) {
  return {
    description: extractTag(rawText, "DESCRIPTION"),
    metaTitle: extractTag(rawText, "META_TITLE"),
    metaDescription: extractTag(rawText, "META_DESCRIPTION"),
    faq: extractTag(rawText, "FAQ"),
  };
}

function extractTag(text, tagName) {
  const match = text.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`));
  return match ? sanitizeHtml(match[1].trim()) : "";
}

function sanitizeHtml(html) {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, "")
    .replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, "")
    .replace(/<embed\b[^>]*>/gi, "")
    .replace(/<link\b[^>]*>/gi, "")
    .replace(/<meta\b[^>]*>/gi, "")
    .replace(/\s(on\w+)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, "")
    .replace(/javascript\s*:/gi, "blocked:")
    .replace(/data\s*:\s*text\/html/gi, "blocked:");
}
