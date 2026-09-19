import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  buildTranscriptEnvelope,
  canonicalizeVideoUrl,
  classifyCollectionError,
  collectVideoTranscript,
  parseVttToTranscript,
  verifyOEmbedIdentity
} from "../subagent-bridge/src/services/video-transcript.js";

const sampleVtt = [
  "WEBVTT",
  "Kind: captions",
  "Language: tr",
  "",
  "00:00:00.000 --> 00:00:02.000",
  "Merhaba <c>dunya</c>",
  "",
  "00:00:02.000 --> 00:00:04.000",
  "Merhaba dunya",
  "",
  "00:00:04.000 --> 00:00:06.000",
  "Ikinci satir"
].join("\n");

test("VIDEO-01: yalnız izinli YouTube watch adresleri kabul edilir", () => {
  assert.deepEqual(canonicalizeVideoUrl("https://www.youtube.com/watch?v=884c8bDYyBM"), {
    videoId: "884c8bDYyBM",
    canonicalUrl: "https://www.youtube.com/watch?v=884c8bDYyBM"
  });
  assert.equal(canonicalizeVideoUrl("https://youtu.be/884c8bDYyBM").videoId, "884c8bDYyBM");
  assert.throws(() => canonicalizeVideoUrl("https://www.youtube.com/shorts/884c8bDYyBM"), /shorts/);
  assert.throws(() => canonicalizeVideoUrl("https://www.youtube.com/watch?v=884c8bDYyBM&list=PL123"), /playlists/);
  assert.throws(() => canonicalizeVideoUrl("https://www.youtube.com/watch?v=884c8bDYyBM&token=gizli"), /rejected/);
  assert.throws(() => canonicalizeVideoUrl("https://kullanici:parola@www.youtube.com/watch?v=884c8bDYyBM"), /rejected/);
  assert.throws(() => canonicalizeVideoUrl("http://example.com/watch?v=884c8bDYyBM"), /not allowed/);
  assert.throws(() => canonicalizeVideoUrl("file:///tmp/video.mp4"), /rejected/);
});

test("VIDEO-02: VTT metni etiketlerden arındırılır ve tekrarlar sadeleşir", () => {
  assert.equal(parseVttToTranscript(sampleVtt), "Merhaba dunya\nIkinci satir");
  assert.equal(parseVttToTranscript(""), "");
});

test("VIDEO-03: zarf yalnız hash ve sınıflandırma taşır", () => {
  const envelope = buildTranscriptEnvelope({
    videoId: "884c8bDYyBM",
    captionKind: "automatic",
    language: "tr",
    transcript: "Merhaba dunya",
    durationSeconds: 65,
    retrievedAt: "2026-09-19T00:00:00.000Z"
  });
  assert.equal(envelope.evidenceSourceType, "untrusted_video_transcript");
  assert.equal(envelope.analysisModality, "transcript_only");
  assert.equal(envelope.videoIdHash.length, 64);
  assert.equal(envelope.transcriptSha256.length, 64);
  assert.equal(JSON.stringify(envelope).includes("884c8bDYyBM"), false);
  assert.equal(JSON.stringify(envelope).includes("Merhaba dunya"), false);
});

test("VIDEO-04: oEmbed kimlik uyuşmazlığı reddedilir", () => {
  assert.throws(
    () => verifyOEmbedIdentity({ title: "Ornek", html: "<iframe src=\"embed/BASKAVIDEOID\"></iframe>" }, "884c8bDYyBM"),
    /identity mismatch/
  );
  assert.throws(() => verifyOEmbedIdentity({ title: "Ornek" }, "884c8bDYyBM"), /html is missing/);
  assert.throws(
    () => verifyOEmbedIdentity({ title: "", html: "<iframe src=\"https://www.youtube.com/embed/884c8bDYyBM\"></iframe>" }, "884c8bDYyBM"),
    /title is missing/
  );
});

test("VIDEO-05: toplama akışı altyazıyı zarf ile birlikte döndürür", async () => {
  const runnerCalls = [];
  const runYtDlp = async (args) => {
    runnerCalls.push(args);
    if (args.includes("--dump-single-json")) {
      return { stdout: JSON.stringify({ id: "884c8bDYyBM", duration: 65, subtitles: { tr: [{}] }, automatic_captions: {} }) };
    }
    const subtitleDirectory = args[args.indexOf("--paths") + 1];
    fs.writeFileSync(path.join(subtitleDirectory, "884c8bDYyBM.tr.vtt"), sampleVtt, "utf8");
    return { stdout: "" };
  };
  const fetchOEmbed = async () => ({ title: "Ornek Video", author_name: "Kanal", html: "<iframe src=\"https://www.youtube.com/embed/884c8bDYyBM\"></iframe>" });
  const result = await collectVideoTranscript({
    url: "https://www.youtube.com/watch?v=884c8bDYyBM",
    runYtDlp,
    fetchOEmbed,
    now: "2026-09-19T00:00:00.000Z"
  });
  assert.equal(result.transcript, "Merhaba dunya\nIkinci satir");
  assert.equal(result.envelope.captionKind, "manual");
  assert.equal(result.envelope.language, "tr");
  assert.equal(result.envelope.durationSeconds, 65);
  assert.equal(result.envelope.titleHash.length, 64);
  assert.equal(result.envelope.authorHash.length, 64);
  assert.equal(JSON.stringify(result.envelope).includes("Ornek Video"), false);
  const subtitleCall = runnerCalls.find((args) => args.includes("--sub-langs"));
  assert.equal(subtitleCall[subtitleCall.indexOf("--sub-langs") + 1], "tr");
  assert.equal(subtitleCall.includes("--write-subs"), true);
  assert.equal(subtitleCall.includes("--write-auto-subs"), false);
});

test("VIDEO-06: altyazısız video ve kimlik uyuşmazlığı fail-closed reddedilir", async () => {
  const runYtDlp = async () => ({ stdout: JSON.stringify({ id: "884c8bDYyBM", duration: 30, subtitles: {}, automatic_captions: {} }) });
  await assert.rejects(
    () => collectVideoTranscript({
      url: "https://www.youtube.com/watch?v=884c8bDYyBM",
      runYtDlp,
      fetchOEmbed: async () => ({ title: "Ornek", html: "<iframe src=\"https://www.youtube.com/embed/BASKAVIDEOID\"></iframe>" }),
      now: "2026-09-19T00:00:00.000Z"
    }),
    /identity mismatch/
  );
  await assert.rejects(
    () => collectVideoTranscript({
      url: "https://www.youtube.com/watch?v=884c8bDYyBM",
      runYtDlp,
      fetchOEmbed: async () => ({ title: "Ornek", html: "<iframe src=\"https://www.youtube.com/embed/884c8bDYyBM\"></iframe>" }),
      now: "2026-09-19T00:00:00.000Z"
    }),
    /no allowed caption track/
  );
  await assert.rejects(
    () => collectVideoTranscript({
      url: "https://www.youtube.com/watch?v=884c8bDYyBM",
      runYtDlp: async (args) => (args.includes("--dump-single-json")
        ? { stdout: JSON.stringify({ id: "BASKAVIDEOID", duration: 30, subtitles: { tr: [{}] } }) }
        : { stdout: "" }),
      fetchOEmbed: async () => ({ title: "Ornek", html: "<iframe src=\"https://www.youtube.com/embed/884c8bDYyBM\"></iframe>" }),
      now: "2026-09-19T00:00:00.000Z"
    }),
    /identity mismatch/
  );
});

test("VIDEO-07: yalnız istenen videonun altyazı dosyası okunur ve boyut sınırı korunur", async () => {
  const runYtDlp = async (args) => {
    if (args.includes("--dump-single-json")) {
      return { stdout: JSON.stringify({ id: "884c8bDYyBM", duration: 65, subtitles: { tr: [{}] } }) };
    }
    const subtitleDirectory = args[args.indexOf("--paths") + 1];
    fs.writeFileSync(path.join(subtitleDirectory, "BASKAVIDEOID.tr.vtt"), "WEBVTT\n\n00:00.000 --> 00:01.000\nYanlis video\n", "utf8");
    fs.writeFileSync(path.join(subtitleDirectory, "884c8bDYyBM.tr.vtt"), sampleVtt, "utf8");
    return { stdout: "" };
  };
  const fetchOEmbed = async () => ({ title: "Ornek", html: "<iframe src=\"https://www.youtube.com/embed/884c8bDYyBM\"></iframe>" });
  const result = await collectVideoTranscript({
    url: "https://www.youtube.com/watch?v=884c8bDYyBM",
    runYtDlp,
    fetchOEmbed,
    now: "2026-09-19T00:00:00.000Z"
  });
  assert.equal(result.transcript.includes("Yanlis video"), false);
  assert.equal(result.transcript.includes("Merhaba dunya"), true);

  await assert.rejects(
    () => collectVideoTranscript({
      url: "https://www.youtube.com/watch?v=884c8bDYyBM",
      runYtDlp: async (args) => {
        if (args.includes("--dump-single-json")) {
          return { stdout: JSON.stringify({ id: "884c8bDYyBM", duration: 65, subtitles: { tr: [{}] } }) };
        }
        const subtitleDirectory = args[args.indexOf("--paths") + 1];
        fs.writeFileSync(path.join(subtitleDirectory, "884c8bDYyBM.tr.vtt"), "x".repeat(2000001), "utf8");
        return { stdout: "" };
      },
      fetchOEmbed,
      now: "2026-09-19T00:00:00.000Z"
    }),
    /subtitle file is too large/
  );
});

test("VIDEO-08: toplama hataları kararlı sınıflara eşlenir", () => {
  assert.equal(classifyCollectionError(new Error("video url is rejected")), "url_rejected");
  assert.equal(classifyCollectionError(new Error("video host is not allowed")), "host_not_allowed");
  assert.equal(classifyCollectionError(new Error("playlists are not allowed")), "unsupported_video");
  assert.equal(classifyCollectionError(new Error("video id is invalid")), "video_id_invalid");
  assert.equal(classifyCollectionError(new Error("video identity mismatch")), "identity_mismatch");
  assert.equal(classifyCollectionError(new Error("video has no allowed caption track")), "caption_unavailable");
  assert.equal(classifyCollectionError(new Error("video transcript is too large")), "transcript_too_large");
  assert.equal(classifyCollectionError(new Error("video subtitle file is too large")), "subtitle_too_large");
  assert.equal(classifyCollectionError(new Error("oembed request failed")), "metadata_unavailable");
  assert.equal(classifyCollectionError(new Error("bilinmeyen")), "collection_error");
});

test("VIDEO-09: otomatik altyazı dalı seçilir ve indirme bayrakları doğru geçirilir", async () => {
  const buildRunYtDlp = (info) => {
    const runnerCalls = [];
    const runYtDlp = async (args) => {
      runnerCalls.push(args);
      if (args.includes("--dump-single-json")) {
        return { stdout: JSON.stringify(info) };
      }
      const subtitleDirectory = args[args.indexOf("--paths") + 1];
      fs.writeFileSync(path.join(subtitleDirectory, "884c8bDYyBM.tr.vtt"), sampleVtt, "utf8");
      return { stdout: "" };
    };
    return { runnerCalls, runYtDlp };
  };
  const fetchOEmbed = async () => ({ title: "Ornek Video", author_name: "Kanal", html: "<iframe src=\"https://www.youtube.com/embed/884c8bDYyBM\"></iframe>" });

  const automaticRunner = buildRunYtDlp({ id: "884c8bDYyBM", duration: 65, subtitles: {}, automatic_captions: { tr: [{}] } });
  const automaticResult = await collectVideoTranscript({
    url: "https://www.youtube.com/watch?v=884c8bDYyBM",
    runYtDlp: automaticRunner.runYtDlp,
    fetchOEmbed,
    now: "2026-09-19T00:00:00.000Z"
  });
  assert.equal(automaticResult.envelope.captionKind, "automatic");
  assert.equal(automaticResult.envelope.language, "tr");
  const automaticSubtitleCall = automaticRunner.runnerCalls.find((args) => args.includes("--sub-langs") && args[args.indexOf("--sub-langs") + 1] === "tr");
  assert.equal(automaticSubtitleCall.includes("--write-auto-subs"), true);
  assert.equal(automaticSubtitleCall.includes("--write-subs"), false);

  const manualRunner = buildRunYtDlp({ id: "884c8bDYyBM", duration: 65, subtitles: { en: [{}] }, automatic_captions: { tr: [{}] } });
  const manualResult = await collectVideoTranscript({
    url: "https://www.youtube.com/watch?v=884c8bDYyBM",
    runYtDlp: manualRunner.runYtDlp,
    fetchOEmbed,
    now: "2026-09-19T00:00:00.000Z"
  });
  assert.equal(manualResult.envelope.captionKind, "manual");
  assert.equal(manualResult.envelope.language, "en");
  const manualSubtitleCall = manualRunner.runnerCalls.find((args) => args.includes("--sub-langs") && args[args.indexOf("--sub-langs") + 1] === "en");
  assert.equal(manualSubtitleCall.includes("--write-subs"), true);
  assert.equal(manualSubtitleCall.includes("--write-auto-subs"), false);
});
