import { useLoaderData, useActionData, useNavigation, useNavigate, Form } from "react-router";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Button,
  TextField,
  Select,
  Banner,
  Box,
  Spinner,
} from "@shopify/polaris";
import { useState, useEffect, useRef } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// ─── Loader ──────────────────────────────────────────────────────────────────

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const brandVoice = await prisma.brandVoice.findUnique({ where: { shop } });
  return Response.json({ brandVoice });
};

// ─── Action ──────────────────────────────────────────────────────────────────

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const actionType = formData.get("actionType");

  if (actionType === "generate") {
    const topic = (formData.get("topic") || "").slice(0, 500).trim();
    const keywords = (formData.get("keywords") || "").slice(0, 500).trim();
    const length = formData.get("length") || "medium";

    if (!topic) return Response.json({ error: "Topic is required." }, { status: 400 });

    const [{ generateBlogPost }, { getCache }] = await Promise.all([
      import("../utils/ai.server.js"),
      import("../utils/cache.server.js"),
    ]);

    const brandVoice = await getCache(
      `bv:${shop}`,
      () => prisma.brandVoice.findUnique({ where: { shop } }),
      300
    );

    const generated = await generateBlogPost(topic, brandVoice, { keywords, length });
    return Response.json({ success: true, generated, topic });
  }

  if (actionType === "publish") {
    const title = formData.get("title") || "";
    const content = formData.get("content") || "";

    if (!title || !content) {
      return Response.json({ error: "Title and content are required to publish." }, { status: 400 });
    }

    // Find or create the default blog
    const blogsResponse = await admin.graphql(`
      query { blogs(first: 1) { edges { node { id title } } } }
    `);
    const { data: blogsData } = await blogsResponse.json();
    let blogId = blogsData?.blogs?.edges?.[0]?.node?.id;

    if (!blogId) {
      const createBlogResult = await admin.graphql(
        `mutation createBlog($blog: BlogCreateInput!) {
          blogCreate(blog: $blog) { blog { id } userErrors { message } }
        }`,
        { variables: { blog: { title: "News" } } }
      );
      const { data: createData } = await createBlogResult.json();
      blogId = createData?.blogCreate?.blog?.id;
    }

    if (!blogId) {
      return Response.json({ error: "Could not find or create a blog to publish to." }, { status: 500 });
    }

    const articleResult = await admin.graphql(
      `mutation createArticle($article: ArticleCreateInput!) {
        articleCreate(article: $article) {
          article { id handle }
          userErrors { field message }
        }
      }`,
      { variables: { article: { blogId, title, body: content, isPublished: true } } }
    );
    const { data: articleData } = await articleResult.json();
    const errors = articleData?.articleCreate?.userErrors ?? [];
    if (errors.length > 0) {
      return Response.json({ error: errors.map((e) => e.message).join("; ") }, { status: 422 });
    }

    return Response.json({
      success: true,
      published: true,
      handle: articleData?.articleCreate?.article?.handle,
    });
  }

  return Response.json({ error: "Unknown action." }, { status: 400 });
};

// ─── Component ───────────────────────────────────────────────────────────────

export default function BlogPage() {
  const { brandVoice } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const navigate = useNavigate();

  const isGenerating = navigation.state === "submitting" && navigation.formData?.get("actionType") === "generate";
  const isPublishing = navigation.state === "submitting" && navigation.formData?.get("actionType") === "publish";

  const [topic, setTopic] = useState("");
  const [keywords, setKeywords] = useState(brandVoice?.targetKeywords || "");
  const [length, setLength] = useState("medium");

  const prevActionData = useRef(null);
  useEffect(() => {
    if (actionData && actionData !== prevActionData.current) {
      prevActionData.current = actionData;
      if (typeof window !== "undefined" && window.shopify?.toast) {
        if (actionData.published) {
          window.shopify.toast.show("Blog post published!", { duration: 4000 });
        } else if (actionData.error) {
          window.shopify.toast.show(actionData.error, { duration: 5000, isError: true });
        }
      }
    }
  }, [actionData]);

  const generated = actionData?.generated;

  const [editedTitle, setEditedTitle] = useState(generated?.title || "");
  const [editedContent, setEditedContent] = useState(generated?.content || "");

  // Sync edits when new content arrives
  if (generated?.title && editedTitle !== generated.title && !isGenerating) {
    setEditedTitle(generated.title);
  }
  if (generated?.content && editedContent !== generated.content && !isGenerating) {
    setEditedContent(generated.content);
  }

  const lengthOptions = [
    { label: "Short (~500 words)", value: "short" },
    { label: "Medium (~1000 words)", value: "medium" },
    { label: "Long (~2000 words)", value: "long" },
  ];

  return (
    <Page
      title="Blog Post Generator"
      subtitle="Generate SEO-friendly blog posts in your brand voice"
      backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
    >
      <BlockStack gap="500">
        {actionData?.error && (
          <Banner tone="critical"><p>{actionData.error}</p></Banner>
        )}
        {actionData?.published && (
          <Banner tone="success" title="Blog Post Published!">
            <p>Your blog post has been published to your Shopify store.</p>
          </Banner>
        )}

        <Layout>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Generate a Blog Post</Text>

                <Form method="post">
                  <input type="hidden" name="actionType" value="generate" />
                  <BlockStack gap="300">
                    <TextField
                      name="topic"
                      label="Blog Topic"
                      value={topic}
                      onChange={setTopic}
                      placeholder="e.g., The benefits of BPC-157 for recovery"
                      helpText="Be specific — a focused topic generates better content"
                      autoComplete="off"
                    />

                    <TextField
                      name="keywords"
                      label="Target Keywords"
                      value={keywords}
                      onChange={setKeywords}
                      placeholder="e.g., peptides, muscle recovery, research chemicals"
                      helpText="Keywords to weave naturally into the post"
                      autoComplete="off"
                    />

                    <Select
                      name="length"
                      label="Post Length"
                      options={lengthOptions}
                      value={length}
                      onChange={setLength}
                    />

                    <Button
                      variant="primary"
                      submit
                      loading={isGenerating}
                      disabled={!topic.trim() || isGenerating}
                      fullWidth
                    >
                      {isGenerating ? "Generating…" : "Generate Blog Post"}
                    </Button>
                  </BlockStack>
                </Form>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            {isGenerating && (
              <Card>
                <Box padding="600">
                  <InlineStack align="center" gap="300">
                    <Spinner size="large" />
                    <Text as="p" variant="bodyLg">Writing your blog post… this takes 20-30 seconds</Text>
                  </InlineStack>
                </Box>
              </Card>
            )}

            {!generated && !isGenerating && (
              <Card>
                <Box padding="800">
                  <BlockStack gap="300" inlineAlign="center">
                    <Text as="p" variant="headingMd" alignment="center" tone="subdued">
                      No blog post yet
                    </Text>
                    <Text as="p" variant="bodySm" alignment="center" tone="subdued">
                      Enter a topic on the left and click Generate Blog Post to create SEO-friendly content in your brand voice.
                    </Text>
                  </BlockStack>
                </Box>
              </Card>
            )}

            {generated && !isGenerating && (
              <BlockStack gap="400">
                <Card>
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">Generated Blog Post</Text>
                    <TextField
                      label="Title"
                      value={editedTitle}
                      onChange={setEditedTitle}
                      autoComplete="off"
                    />
                    <TextField
                      label="Content (HTML)"
                      value={editedContent}
                      onChange={setEditedContent}
                      multiline={16}
                      helpText="Edit the HTML content before publishing"
                      autoComplete="off"
                    />
                  </BlockStack>
                </Card>

                {editedContent && (
                  <Card>
                    <BlockStack gap="300">
                      <Text as="h2" variant="headingMd">Preview</Text>
                      <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                        <div dangerouslySetInnerHTML={{ __html: editedContent }} />
                      </Box>
                    </BlockStack>
                  </Card>
                )}

                <Card>
                  <Form method="post">
                    <input type="hidden" name="actionType" value="publish" />
                    <input type="hidden" name="title" value={editedTitle} />
                    <input type="hidden" name="content" value={editedContent} />
                    <Button
                      variant="primary"
                      size="large"
                      submit
                      loading={isPublishing}
                      disabled={isPublishing}
                      fullWidth
                    >
                      {isPublishing ? "Publishing…" : "Publish to Shopify Blog"}
                    </Button>
                  </Form>
                </Card>
              </BlockStack>
            )}

            {!generated && !isGenerating && (
              <Card>
                <Box padding="600">
                  <BlockStack gap="300" inlineAlign="center">
                    <Text as="h2" variant="headingMd" alignment="center">Start driving organic traffic ✍️</Text>
                    <Text as="p" variant="bodyMd" tone="subdued" alignment="center">
                      Write your first AI-powered blog post in under 60 seconds.
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued" alignment="center">
                      Blog posts are written in your brand voice and optimised for the keywords in your Settings.
                    </Text>
                  </BlockStack>
                </Box>
              </Card>
            )}
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
