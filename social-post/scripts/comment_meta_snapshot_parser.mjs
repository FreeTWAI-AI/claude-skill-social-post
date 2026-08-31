/**
 * Pure parsers for the accessibility snapshots exposed by the bundled Chrome
 * controller.  Meta class names are intentionally ignored: stable post and
 * comment permalinks are the identity boundary.
 */

import { fail, immutableJsonSnapshot, requiredString } from "./comment_chrome_common.mjs";

export const META_SNAPSHOT_ADAPTER_VERSION = "2026-08-30.1";

function textValue(raw) {
  let value = String(raw ?? "").trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try { value = JSON.parse(value); } catch { value = value.slice(1, -1); }
  }
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function languageOf(value) {
  const text = String(value ?? "");
  if (/\p{Script=Cyrillic}/u.test(text)) return "ru";
  if (/\p{Script=Han}/u.test(text)) return "zh-Hant";
  if (/[áéíóúñ¿¡]/iu.test(text)) return "es";
  if (/[ãõç]/iu.test(text)) return "pt";
  if (/^[\p{Emoji}\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u.test(text)) return "zxx";
  if (/[A-Za-z]/u.test(text)) return "en";
  return "und";
}

function absoluteUrl(platform, raw) {
  const value = requiredString(raw, `${platform} snapshot URL`);
  const origin = {
    facebook: "https://www.facebook.com",
    instagram: "https://www.instagram.com",
    threads: "https://www.threads.com",
  }[platform];
  return new URL(value, origin).toString();
}

function cleanParentUrl(raw) {
  const url = new URL(raw);
  url.search = "";
  url.hash = "";
  return url.toString();
}

function ownByProfileUrl(platform, accountKey, profileUrl) {
  if (!profileUrl) return false;
  const path = new URL(absoluteUrl(platform, profileUrl)).pathname.replace(/^\/@?/u, "").replace(/\/$/u, "");
  return path.toLowerCase() === String(accountKey).replace(/^@/u, "").toLowerCase();
}

function assertSnapshot(raw) {
  if (typeof raw !== "string" || !raw.trim()) fail("Meta accessible snapshot is missing");
  return raw.replace(/\r\n?/gu, "\n");
}

function parentMatches(observed, expected) {
  return cleanParentUrl(observed) === cleanParentUrl(expected);
}

function facebookBody(block, timeUrlIndex) {
  const tail = block.slice(timeUrlIndex);
  const endCandidates = [
    tail.search(/\n\s*- button "(?:刪除、隱藏或檢舉此留言|讚|回覆)"/u),
    tail.search(/\n\s*- article /u),
  ].filter((value) => value >= 0);
  const bodyArea = endCandidates.length ? tail.slice(0, Math.min(...endCandidates)) : tail;
  const parts = [];
  for (const line of bodyArea.split("\n")) {
    const textMatch = line.match(/^\s*- text:\s*(.+)$/u);
    if (textMatch) parts.push(textValue(textMatch[1]));
    const imageMatch = line.match(/^\s*- img "([^"]+)"/u);
    if (imageMatch && /\p{Extended_Pictographic}/u.test(imageMatch[1])) parts.push(imageMatch[1]);
  }
  return parts.join("").trim();
}

function facebookArticleBlocks(snapshot) {
  const lines = snapshot.split("\n");
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)- article "(.+?)的留言[^"]*":\s*$/u);
    if (!match) continue;
    const indent = match[1].length;
    let end = index + 1;
    while (end < lines.length) {
      const line = lines[end];
      if (line.trim() && (line.match(/^\s*/u)?.[0].length ?? 0) <= indent) break;
      end += 1;
    }
    blocks.push({ authorDisplay: match[2], indent, block: lines.slice(index, end).join("\n") });
    index = end - 1;
  }
  return blocks;
}

export function parseFacebookSnapshot(rawSnapshot, target) {
  const snapshot = assertSnapshot(rawSnapshot);
  const expectedParent = cleanParentUrl(target.post_permalink);
  const comments = [];
  for (const item of facebookArticleBlocks(snapshot)) {
    const permalinkMatch = [...item.block.matchAll(
      /- \/url: (https:\/\/www\.facebook\.com\/[^\s]+\?comment_id=([^&\s]+)[^\s]*)/gu,
    )].find((match) => parentMatches(match[1], expectedParent));
    if (!permalinkMatch) continue;
    const observedParent = cleanParentUrl(permalinkMatch[1]);
    if (!parentMatches(observedParent, expectedParent)) continue;
    const authorLinkMatch = item.block.match(/- link "[^"]+":\n\s+- \/url: (https:\/\/www\.facebook\.com\/([^?\/\s]+)[^\s]*)/u);
    const body = facebookBody(item.block, item.block.indexOf(permalinkMatch[0]));
    if (!body) fail("Facebook comment body is not complete in the accessible snapshot");
    const isOwn = ownByProfileUrl("facebook", target.account_key, authorLinkMatch?.[1]);
    const nestedOwnReply = /\n\s+- article /u.test(item.block)
      && item.block.includes(`https://www.facebook.com/${target.account_key}`);
    const candidate = {
      platform_comment_id: decodeURIComponent(permalinkMatch[2]),
      comment_permalink: `${expectedParent}?comment_id=${encodeURIComponent(decodeURIComponent(permalinkMatch[2]))}`,
      observed_parent_post_permalink: expectedParent,
      author_key: authorLinkMatch?.[2] || item.authorDisplay,
      author_display: item.authorDisplay,
      body,
      body_complete: !/查看更多/u.test(item.block),
      is_own: isOwn,
      has_own_reply: nestedOwnReply
        || (isOwn && /[?&]reply_comment_id=/u.test(permalinkMatch[1])),
      language: languageOf(body),
    };
    const duplicateIndex = comments.findIndex((comment) => (
      comment.platform_comment_id === candidate.platform_comment_id
    ));
    if (duplicateIndex >= 0) {
      const existing = comments[duplicateIndex];
      let selected = existing;
      const ownershipDiffers = existing.is_own !== candidate.is_own;
      if (ownershipDiffers) {
        selected = existing.is_own ? candidate : existing;
      } else if (existing.author_display !== candidate.author_display) {
        fail(`Facebook comment ${candidate.platform_comment_id} has conflicting duplicate rows`);
      }
      if (existing.body !== candidate.body) {
        if (ownershipDiffers) {
          // A nested own reply can repeat the parent's permalink inside its
          // accessibility block. Keep the external row selected above.
        } else if (existing.body.startsWith(candidate.body)) selected = candidate;
        else if (!candidate.body.startsWith(existing.body)) {
          fail(`Facebook comment ${candidate.platform_comment_id} has conflicting duplicate bodies`);
        }
      }
      const externalAuthorKey = [existing.author_key, candidate.author_key]
        .find((key) => String(key).toLowerCase() !== String(target.account_key).toLowerCase());
      comments[duplicateIndex] = {
        ...selected,
        author_key: externalAuthorKey || selected.author_key,
        body_complete: existing.body_complete && candidate.body_complete,
        has_own_reply: existing.has_own_reply || candidate.has_own_reply,
      };
    } else {
      comments.push(candidate);
    }
  }
  const relevantSnapshot = snapshot.slice(Math.max(0, snapshot.lastIndexOf(target.post_key) - 12000));
  const expectedCountMatches = [...relevantSnapshot.matchAll(/- button "留言":\n\s+- generic: "?(\d+)"?/gu)];
  const explicitZero = /(?:尚無留言|目前沒有留言|搶先留言|成為第一個留言)/u
    .test(relevantSnapshot);
  const visibleArticleCount = [...relevantSnapshot.matchAll(
    /^\s*- article "[^"]*留言[^"]*":/gmu,
  )].length;
  if (!expectedCountMatches.length && comments.length === 0 && !explicitZero) {
    fail("Facebook snapshot has no terminal comment count or explicit zero state");
  }
  const expectedCount = expectedCountMatches.length
    ? Number(expectedCountMatches.at(-1)[1]) : comments.length;
  // Facebook's displayed "留言" count includes nested replies. Queue rows are
  // root comments, while terminal coverage must compare the count against all
  // visible comment/reply articles.
  if (visibleArticleCount < expectedCount) {
    fail(`Facebook snapshot exposes ${visibleArticleCount} of ${expectedCount} comment articles`);
  }
  // Facebook commonly keeps an unrelated background status node named
  // "載入中" even after every count-bound comment permalink is present.  The
  // visible count is the stronger terminal invariant; only block a loading
  // state when it coincides with missing count-bound rows.
  if (/status "載入中/u.test(relevantSnapshot)
      && expectedCount > 0 && visibleArticleCount === 0) {
    fail("Facebook comments are still loading; terminal coverage is not proven");
  }
  return immutableJsonSnapshot({
    comments,
    comments_expanded: true,
    replies_expanded: !/查看(?:全部)?\s*\d+\s*則回覆/u.test(relevantSnapshot),
    evidence: `facebook accessible snapshot mapped ${comments.length} stable comment_id permalink(s)`,
  }, "Facebook snapshot parse");
}

function previousInstagramAuthor(lines, index) {
  for (let cursor = index - 1; cursor >= Math.max(0, index - 12); cursor -= 1) {
    const match = lines[cursor].match(/^\s*- link "([^"]+)":\s*$/u);
    if (!match || /大頭貼照/u.test(match[1])) continue;
    const urlLine = lines.slice(cursor + 1, cursor + 4).find((line) => /- \/url: \/[^/]+\/$/u.test(line));
    if (urlLine) return { display: match[1], url: urlLine.match(/- \/url:\s*(\S+)/u)?.[1] };
  }
  return null;
}

export function parseInstagramSnapshot(rawSnapshot, target) {
  const snapshot = assertSnapshot(rawSnapshot);
  if (/heading "尚無留言。"/u.test(snapshot)) {
    return immutableJsonSnapshot({
      comments: [], comments_expanded: true, replies_expanded: true,
      evidence: "instagram explicitly reports no comments",
    }, "Instagram zero-comment snapshot parse");
  }
  if (/progressbar|載入中|查看全部\s*\d+\s*則回覆/u.test(snapshot)) {
    fail("Instagram comment or reply coverage is not terminal");
  }
  const lines = snapshot.split("\n");
  const comments = [];
  const postKey = requiredString(target.post_key, "Instagram target post_key");
  const pattern = new RegExp(`^\\s*- \\/url: (\\/p\\/${postKey}\\/c\\/([^/]+)\\/)\\s*$`, "u");
  for (let index = 0; index < lines.length; index += 1) {
    const permalinkMatch = lines[index].match(pattern);
    if (!permalinkMatch) continue;
    const author = previousInstagramAuthor(lines, index);
    if (!author) fail("Instagram comment has no author bound to its permalink");
    let body = "";
    for (let cursor = index + 1; cursor < Math.min(lines.length, index + 8); cursor += 1) {
      const match = lines[cursor].match(/^\s*- generic:\s*(.+)$/u);
      if (match) { body = textValue(match[1]); break; }
      if (/^\s*- button/u.test(lines[cursor])) break;
    }
    if (!body) fail("Instagram comment body is not complete in the accessible snapshot");
    comments.push({
      platform_comment_id: permalinkMatch[2],
      comment_permalink: absoluteUrl("instagram", permalinkMatch[1]),
      observed_parent_post_permalink: cleanParentUrl(target.post_permalink),
      author_key: author.display,
      author_display: author.display,
      body,
      body_complete: true,
      is_own: ownByProfileUrl("instagram", target.account_key, author.url),
      has_own_reply: false,
      language: languageOf(body),
    });
  }
  return immutableJsonSnapshot({
    comments, comments_expanded: true, replies_expanded: true,
    evidence: `instagram accessible snapshot mapped ${comments.length} stable /c/ permalink(s)`,
  }, "Instagram snapshot parse");
}

function threadsRegion(snapshot) {
  const start = snapshot.indexOf('- region "直欄內文":');
  if (start < 0) fail("Threads post region is missing");
  const end = snapshot.indexOf("\n- contentinfo:", start);
  return snapshot.slice(start, end < 0 ? snapshot.length : end);
}

function parseThreadsEntries(region, target) {
  const lines = region.split("\n");
  const entries = [];
  for (let index = 0; index < lines.length; index += 1) {
    const timeUrlMatch = lines[index].match(/^\s*- \/url: (\/@([^/]+)\/post\/([^\s/]+))\s*$/u);
    if (!timeUrlMatch) continue;
    let author = null;
    for (let cursor = index - 1; cursor >= Math.max(0, index - 10); cursor -= 1) {
      const linkMatch = lines[cursor].match(/^\s*- link "([^"]+)":\s*$/u);
      if (linkMatch && !/大頭貼照/u.test(linkMatch[1]) && linkMatch[1] === timeUrlMatch[2]) {
        author = linkMatch[1]; break;
      }
    }
    if (!author) continue;
    let body = "";
    let replyCount = 0;
    for (let cursor = index + 1; cursor < Math.min(lines.length, index + 22); cursor += 1) {
      if (cursor > index + 1 && /^\s*- link "[^"]+的大頭貼照"/u.test(lines[cursor])) break;
      const bodyMatch = lines[cursor].match(/^\s*- (?:generic|text):\s*(.+)$/u);
      if (bodyMatch && !body && !/^(?:·|作者|\d+|\/)$/.test(textValue(bodyMatch[1]))) {
        body = textValue(bodyMatch[1]);
      }
      const replyMatch = lines[cursor].match(/- button "已回覆 (\d+)"/u);
      if (replyMatch) replyCount = Number(replyMatch[1]);
    }
    entries.push({
      author,
      permalink: absoluteUrl("threads", timeUrlMatch[1]),
      postKey: timeUrlMatch[3],
      body,
      replyCount,
      isOwn: author.toLowerCase() === String(target.account_key).replace(/^@/u, "").toLowerCase(),
    });
  }
  return entries;
}

export function parseThreadsSnapshot(rawSnapshot, target) {
  const region = threadsRegion(assertSnapshot(rawSnapshot));
  if (/progressbar|載入中|顯示更多回覆|查看更多回覆/u.test(region)) {
    fail("Threads reply coverage is not terminal");
  }
  const entries = parseThreadsEntries(region, target);
  const primaryIndex = entries.findIndex((entry) => (
    cleanParentUrl(entry.permalink) === cleanParentUrl(target.post_permalink)
  ));
  if (primaryIndex < 0) fail("Threads target post permalink is not visible");
  const comments = [];
  for (let index = primaryIndex + 1; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.isOwn || !entry.body) continue;
    let ownReplies = 0;
    for (let cursor = index + 1; cursor < entries.length && entries[cursor].isOwn; cursor += 1) {
      ownReplies += 1;
    }
    if (entry.replyCount > ownReplies && entry.replyCount > 0) {
      fail(`Threads reply ${entry.postKey} exposes ${ownReplies} of ${entry.replyCount} child replies`);
    }
    comments.push({
      platform_comment_id: entry.postKey,
      comment_permalink: entry.permalink,
      observed_parent_post_permalink: cleanParentUrl(target.post_permalink),
      author_key: entry.author,
      author_display: entry.author,
      body: entry.body,
      body_complete: true,
      is_own: false,
      has_own_reply: ownReplies > 0,
      language: languageOf(entry.body),
    });
  }
  const rootReplyCount = entries[primaryIndex].replyCount;
  const visibleRootEntries = entries.length - primaryIndex - 1;
  if (rootReplyCount > visibleRootEntries) {
    fail(`Threads root exposes ${visibleRootEntries} of ${rootReplyCount} replies`);
  }
  return immutableJsonSnapshot({
    comments, comments_expanded: true, replies_expanded: true,
    evidence: `threads accessible snapshot mapped ${comments.length} external stable reply permalink(s)`,
  }, "Threads snapshot parse");
}

export function parseMetaCommentSnapshot(platform, snapshot, target) {
  if (platform === "facebook") return parseFacebookSnapshot(snapshot, target);
  if (platform === "instagram") return parseInstagramSnapshot(snapshot, target);
  if (platform === "threads") return parseThreadsSnapshot(snapshot, target);
  fail(`unsupported Meta snapshot platform ${platform}`);
}
