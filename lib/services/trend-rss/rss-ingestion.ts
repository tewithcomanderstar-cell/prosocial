import { createHash } from "crypto";
import { fetchWithRetry } from "@/lib/services/http";
import { RssSource } from "@/models/RssSource";
import { RssArticle } from "@/models/RssArticle";

function decodeEntities(input: string) {
  return input
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripTags(input: string) {
  return decodeEntities(input).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function extractTag(block: string, tag: string) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? stripTags(match[1]) : "";
}

function extractItems(xml: string) {
  return xml.match(/<item[\s\S]*?<\/item>/gi) ?? xml.match(/<entry[\s\S]*?<\/entry>/gi) ?? [];
}

function fingerprintArticle(url: string, title: string) {
  return createHash("sha1").update(`${url}|${title}`).digest("hex");
}

function extractUrl(block: string) {
  const directLink = extractTag(block, "link");
  if (directLink) return directLink;
  const hrefMatch = block.match(/<link[^>]+href=["']([^"']+)["']/i);
  return hrefMatch?.[1] ?? "";
}

function extractPublishedAt(block: string) {
  return extractTag(block, "pubDate") || extractTag(block, "published") || extractTag(block, "updated");
}

function extractEntities(title: string, summary: string) {
  const joined = `${title} ${summary}`.toLowerCase();
  const matches = joined.match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  return [...new Set(matches)].slice(0, 12);
}

export async function ingestRssArticles(userId: string) {
  const sources = (await RssSource.find({ userId, active: true }).lean()) as unknown as Array<{
    _id: unknown;
    rssUrl: string;
  }>;
  let storedArticles = 0;

  for (const source of sources) {
    const response = await fetchWithRetry(source.rssUrl, { cache: "no-store" });
    if (!response.ok) continue;

    const xml = await response.text();
    for (const item of extractItems(xml).slice(0, 30)) {
      const title = extractTag(item, "title");
      const url = extractUrl(item);
      if (!title || !url) continue;
      const summary = extractTag(item, "description") || extractTag(item, "summary");
      const fullContent =
        extractTag(item, "content:encoded") || extractTag(item, "content") || summary;
      const fingerprint = fingerprintArticle(url, title);

      await RssArticle.findOneAndUpdate(
        { userId, fingerprint },
        {
          userId,
          rssSourceId: source._id,
          title,
          url,
          publishedAt: extractPublishedAt(item) ? new Date(extractPublishedAt(item)) : null,
          summary,
          fullContent,
          entities: extractEntities(title, summary),
          fingerprint,
          fetchedAt: new Date()
        },
        { upsert: true, new: true }
      );

      storedArticles += 1;
    }
  }

  return {
    sourceCount: sources.length,
    storedArticles
  };
}
