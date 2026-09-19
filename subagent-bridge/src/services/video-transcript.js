import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { containsSensitiveWebValue } from "../web-evidence.js";

const execFileAsync = promisify(execFile);

const ALLOWED_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]);
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const MAX_TRANSCRIPT_CHARACTERS = 400000;
const MAX_SUBTITLE_BYTES = 2000000;
const DEFAULT_COLLECTION_TIMEOUT_MS = 120000;
const DEFAULT_LANGUAGE_PREFERENCE = ["tr", "en"];

export const videoTranscriptEnvelopeSchema = {
  schemaVersion: 1,
  evidenceSourceType: "untrusted_video_transcript",
  contentTrust: "untrusted",
  quarantineStatus: "quarantined"
};

export function canonicalizeVideoUrl(value) {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("video url is required");
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("video url is invalid");
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("video url is rejected");
  }
  const host = parsed.hostname.toLocaleLowerCase("en-US");
  if (!ALLOWED_HOSTS.has(host)) throw new Error("video host is not allowed");
  if (containsSensitiveWebValue(parsed.search) || containsSensitiveWebValue(parsed.hash)) {
    throw new Error("video url is rejected");
  }
  if (parsed.pathname.toLocaleLowerCase("en-US").startsWith("/playlist") || parsed.searchParams.has("list")) {
    throw new Error("playlists are not allowed");
  }
  if (parsed.pathname.toLocaleLowerCase("en-US").startsWith("/live")) throw new Error("live streams are not allowed");
  if (parsed.pathname.toLocaleLowerCase("en-US").startsWith("/shorts")) throw new Error("shorts are not allowed");
  const videoId = host === "youtu.be"
    ? parsed.pathname.split("/").filter(Boolean)[0]
    : parsed.searchParams.get("v");
  if (!videoId || !VIDEO_ID_PATTERN.test(videoId)) throw new Error("video id is invalid");
  return { videoId, canonicalUrl: `https://www.youtube.com/watch?v=${videoId}` };
}

export function parseVttToTranscript(vtt) {
  if (typeof vtt !== "string" || vtt.trim().length === 0) return "";
  const lines = vtt.replace(/\r/g, "").split("\n");
  const output = [];
  let previous = "";
  for (const line of lines) {
    if (!line.trim()) continue;
    if (/^WEBVTT|^NOTE|^Kind:|^Language:/i.test(line)) continue;
    if (line.includes("-->")) continue;
    const text = line.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (!text || text === previous) continue;
    output.push(text);
    previous = text;
  }
  const transcript = output.join("\n");
  if (transcript.length > MAX_TRANSCRIPT_CHARACTERS) throw new Error("video transcript is too large");
  return transcript;
}

export function hashVideoIdentifier(videoId) {
  return crypto.createHash("sha256").update(`video:${videoId}`, "utf8").digest("hex");
}

export function hashTranscript(transcript) {
  return crypto.createHash("sha256").update(transcript, "utf8").digest("hex");
}

export function verifyOEmbedIdentity(oembed, videoId) {
  if (!oembed || typeof oembed !== "object") throw new Error("oembed response is invalid");
  const html = typeof oembed.html === "string" ? oembed.html : "";
  if (html.length === 0) throw new Error("oembed html is missing");
  if (!html.includes(videoId)) throw new Error("video identity mismatch");
  if (typeof oembed.title !== "string" || oembed.title.trim().length === 0) throw new Error("oembed title is missing");
  return {
    titleHash: crypto.createHash("sha256").update(oembed.title, "utf8").digest("hex"),
    authorHash: typeof oembed.author_name === "string" && oembed.author_name.length > 0
      ? crypto.createHash("sha256").update(oembed.author_name, "utf8").digest("hex")
      : null
  };
}

export function buildTranscriptEnvelope({ videoId, captionKind, language, transcript, durationSeconds, retrievedAt }) {
  if (!VIDEO_ID_PATTERN.test(String(videoId || ""))) throw new Error("video id is invalid");
  if (!["manual", "automatic", "translated"].includes(captionKind)) throw new Error("caption kind is invalid");
  if (typeof transcript !== "string" || transcript.trim().length === 0) throw new Error("transcript is required");
  if (typeof language !== "string" || language.trim().length === 0) throw new Error("language is required");
  return {
    ...videoTranscriptEnvelopeSchema,
    platform: "youtube",
    videoIdHash: hashVideoIdentifier(videoId),
    retrievedAt: retrievedAt || new Date().toISOString(),
    acquisitionMethod: "yt-dlp_subtitles_and_oembed",
    captionKind,
    language,
    transcriptSha256: hashTranscript(transcript),
    durationSeconds: Number.isInteger(durationSeconds) && durationSeconds > 0 ? durationSeconds : null,
    analysisModality: "transcript_only"
  };
}

function captionTracksFor(info, field) {
  const value = info?.[field];
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
}

function selectCaptionTrack(info, preferredLanguages) {
  const manualLanguages = captionTracksFor(info, "subtitles");
  const automaticLanguages = captionTracksFor(info, "automatic_captions");
  for (const language of preferredLanguages) {
    const manual = manualLanguages.find((candidate) => candidate === language || candidate.startsWith(`${language}-`));
    if (manual) return { language: manual, captionKind: "manual" };
  }
  for (const language of preferredLanguages) {
    const automatic = automaticLanguages.find((candidate) => candidate === language || candidate.startsWith(`${language}-`));
    if (automatic) return { language: automatic, captionKind: "automatic" };
  }
  throw new Error("video has no allowed caption track");
}

function readFirstSubtitleFile(directory, videoId) {
  const entries = fs.readdirSync(directory).filter((entry) => entry.toLocaleLowerCase("en-US").endsWith(".vtt")).sort();
  const matching = entries.filter((entry) => entry.includes(videoId));
  if (matching.length === 0) throw new Error("video subtitle file is missing");
  const subtitlePath = path.join(directory, matching[0]);
  if (fs.statSync(subtitlePath).size > MAX_SUBTITLE_BYTES) throw new Error("video subtitle file is too large");
  return fs.readFileSync(subtitlePath, "utf8");
}

export function classifyCollectionError(error) {
  const message = String(error?.message || "");
  if (/url is required|url is invalid|url is rejected/.test(message)) return "url_rejected";
  if (/host is not allowed/.test(message)) return "host_not_allowed";
  if (/playlists|live streams|shorts/.test(message)) return "unsupported_video";
  if (/video id is invalid/.test(message)) return "video_id_invalid";
  if (/identity mismatch/.test(message)) return "identity_mismatch";
  if (/no allowed caption track/.test(message)) return "caption_unavailable";
  if (/transcript is too large/.test(message)) return "transcript_too_large";
  if (/subtitle file is too large/.test(message)) return "subtitle_too_large";
  if (/oembed/.test(message)) return "metadata_unavailable";
  return "collection_error";
}

export async function collectVideoTranscript({ url, runYtDlp, fetchOEmbed, timeoutMs, now } = {}) {
  const { videoId, canonicalUrl } = canonicalizeVideoUrl(url);
  const options = { timeoutMs: Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_COLLECTION_TIMEOUT_MS };
  const runner = runYtDlp || (async (args) => {
    const result = await execFileAsync("yt-dlp", args, { timeout: options.timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return { stdout: result.stdout, stderr: result.stderr };
  });
  const oembedFetcher = fetchOEmbed || (async (targetUrl) => {
    const response = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(targetUrl)}&format=json`, { signal: AbortSignal.timeout(options.timeoutMs) });
    if (!response.ok) throw new Error("oembed request failed");
    return response.json();
  });
  const oembed = verifyOEmbedIdentity(await oembedFetcher(canonicalUrl), videoId);
  const infoResult = await runner(["--dump-single-json", "--skip-download", "--no-playlist", canonicalUrl]);
  let info;
  try {
    info = JSON.parse(infoResult.stdout);
  } catch {
    throw new Error("video metadata is invalid");
  }
  if (info?.id !== videoId) throw new Error("video identity mismatch");
  const { language, captionKind } = selectCaptionTrack(info, DEFAULT_LANGUAGE_PREFERENCE);
  const subtitleDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "video-subtitles-"));
  try {
    await runner([
      "--skip-download",
      "--no-playlist",
      "--sub-format", "vtt",
      "--sub-langs", language,
      captionKind === "manual" ? "--write-subs" : "--write-auto-subs",
      "--paths", subtitleDirectory,
      canonicalUrl
    ]);
    const transcript = parseVttToTranscript(readFirstSubtitleFile(subtitleDirectory, videoId));
    const envelope = buildTranscriptEnvelope({
      videoId,
      captionKind,
      language,
      transcript,
      durationSeconds: Number.isFinite(info.duration) ? Math.round(info.duration) : null,
      retrievedAt: now || new Date().toISOString()
    });
    return { envelope: { ...envelope, ...oembed }, transcript };
  } finally {
    try {
      fs.rmSync(subtitleDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
    }
  }
}

export const videoTranscriptLimits = {
  maxTranscriptCharacters: MAX_TRANSCRIPT_CHARACTERS,
  maxSubtitleBytes: MAX_SUBTITLE_BYTES,
  defaultCollectionTimeoutMs: DEFAULT_COLLECTION_TIMEOUT_MS,
  defaultLanguagePreference: DEFAULT_LANGUAGE_PREFERENCE
};
