import { describe, expect, it } from "vitest";
import { podcastTranscriptEvidenceEnvelope, stableEvidenceUrl } from "./podcast-evidence.js";

describe("podcast transcript evidence envelope", () => {
  it("preserves RSS, program-page, and transcript payloads while removing only ephemeral URL credentials", () => {
    const envelope = JSON.parse(podcastTranscriptEvidenceEnvelope({
      adapter_version: "rss-podcast-transcript-v1",
      fetched_at: "2026-09-13T00:00:00.000Z",
      episode: {
        url: "https://pod.example/episodes/1?lang=en&sig=ephemeral", title: "Episode 1",
        author: null, published_at: "2026-09-13T00:00:00.000Z", body: "show notes",
        body_kind: "show_notes", raw: JSON.stringify({
          link: "https://pod.example/episodes/1?lang=en",
          "podcast:transcript": { "@_url": "https://cdn.example/transcript?lang=en&token=ephemeral" },
        }),
      },
      program_page: {
        stable_url: "https://pod.example/episodes/1?lang=en&X-Amz-Signature=ephemeral",
        content_type: "text/html", raw_payload: "<html>episode page</html>",
      },
      transcript: {
        outcome: "success", stable_url: "https://cdn.example/transcript?lang=en&token=ephemeral",
        content_type: "text/plain", raw_payload: "Speaker: original payload", cleaned_body: "Speaker: cleaned body",
        bytes: 25, duration_ms: 42,
      },
    }));

    expect(envelope).toMatchObject({
      schema_version: "podcast-transcript-evidence-v2",
      episode: { url: "https://pod.example/episodes/1?lang=en" },
      program_page: { stable_url: "https://pod.example/episodes/1?lang=en", raw_payload: "<html>episode page</html>" },
      transcript: { stable_url: "https://cdn.example/transcript?lang=en", raw_payload: "Speaker: original payload" },
    });
    expect(envelope.transcript.source_payload_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(envelope.transcript.archived_payload_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(envelope.transcript.cleaned_body_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(envelope.episode.rss_item)).toEqual({
      link: "https://pod.example/episodes/1?lang=en",
      "podcast:transcript": { "@_url": "https://cdn.example/transcript?lang=en" },
    });
  });

  it("also redacts credentials from malformed adapter raw before archiving", () => {
    const envelope = JSON.parse(podcastTranscriptEvidenceEnvelope({
      adapter_version: "rss-podcast-transcript-v1", fetched_at: "2026-09-13T00:00:00.000Z",
      episode: { url: "https://pod.example/episodes/1", title: "Episode 1", author: null, published_at: null,
        body: "", body_kind: "show_notes", raw: "invalid https://cdn.example/t?token=ephemeral&lang=en raw" },
      program_page: { stable_url: "https://pod.example/episodes/1", content_type: null, raw_payload: "page" },
      transcript: { outcome: "success", stable_url: "https://cdn.example/t", content_type: "text/plain", raw_payload: "raw", cleaned_body: "clean", bytes: 3, duration_ms: 1 },
    }));
    expect(envelope.episode.rss_item).toBe("invalid https://cdn.example/t?lang=en raw");
  });

  it("redacts credentials embedded in RSS HTML fields", () => {
    const envelope = JSON.parse(podcastTranscriptEvidenceEnvelope({
      adapter_version: "rss-podcast-transcript-v1", fetched_at: "2026-09-13T00:00:00.000Z",
      episode: { url: "https://pod.example/episodes/1", title: "Episode 1", author: null, published_at: null,
        body: "", body_kind: "show_notes", raw: JSON.stringify({
          "content:encoded": '<a href="https://cdn.example/t?lang=en&amp;token=ephemeral">transcript</a>',
        }) },
      program_page: { stable_url: "https://pod.example/episodes/1", content_type: null, raw_payload: "page" },
      transcript: { outcome: "success", stable_url: "https://cdn.example/t", content_type: "text/plain", raw_payload: "raw", cleaned_body: "clean", bytes: 3, duration_ms: 1 },
    }));
    expect(envelope.episode.rss_item).toBe('{"content:encoded":"<a href=\\"https://cdn.example/t?lang=en\\">transcript</a>"}');
  });

  it("does not strip a non-credential query parameter", () => {
    expect(stableEvidenceUrl("https://pod.example/t?format=vtt&signature=abc#cue"))
      .toBe("https://pod.example/t?format=vtt");
  });

  it("removes credential-like parameters and URL userinfo without changing semantic parameters", () => {
    expect(stableEvidenceUrl(
      "https://reader:password@pod.example/t?lang=en&page=2&api_key=secret&authorization=Bearer%20secret&access_token=secret&client-secret=secret&session_id=secret",
    )).toBe("https://pod.example/t?lang=en&page=2");
  });

  it("does not over-match ordinary parameter names that merely contain a credential word", () => {
    expect(stableEvidenceUrl("https://pod.example/t?monkey=1&keyboard=2&authorship=3"))
      .toBe("https://pod.example/t?monkey=1&keyboard=2&authorship=3");
  });

  it("does not persist credentials embedded in RSS, HTML, JSON, or transcript payloads", () => {
    const serialized = podcastTranscriptEvidenceEnvelope({
      adapter_version: "rss-podcast-transcript-v1",
      fetched_at: "2026-09-13T00:00:00.000Z",
      episode: {
        url: "https://pod.example/episodes/1", title: "Episode 1", author: null,
        published_at: "2026-09-13T00:00:00.000Z", body: "show notes", body_kind: "show_notes",
        raw: '<podcast:transcript url="https://reader:password@cdn.example/t?lang=en&token=rss-secret" /><api_key>xml-secret</api_key><auth:token>namespace-secret</auth:token>',
      },
      program_page: {
        stable_url: "https://pod.example/episodes/1", content_type: "text/html",
        raw_payload: '<a href="https://cdn.example/t?api_key=page-secret&lang=en">download</a>',
      },
      transcript: {
        outcome: "success", stable_url: "https://cdn.example/t", content_type: "application/json",
        raw_payload: String.raw`{"authorization":"transcript-secret","caption":"hello","link":"https:\/\/reader:json-pass@cdn.example\/t?token=json-secret&lang=en"}\nAuthorization: Bearer header-secret`, cleaned_body: "hello",
        bytes: 5, duration_ms: 42,
      },
    });

    expect(serialized).not.toContain("rss-secret");
    expect(serialized).not.toContain("page-secret");
    expect(serialized).not.toContain("transcript-secret");
    expect(serialized).not.toContain("header-secret");
    expect(serialized).not.toContain("xml-secret");
    expect(serialized).not.toContain("namespace-secret");
    expect(serialized).not.toContain("json-pass");
    expect(serialized).not.toContain("json-secret");
    expect(serialized).toContain("https://cdn.example/t?lang=en");
    const envelope = JSON.parse(serialized);
    expect(envelope.episode.rss_item).toContain("<podcast:transcript");
    expect(envelope.episode.rss_item).toContain("<api_key><redacted></api_key>");
    expect(envelope.episode.rss_item).toContain("<auth:token><redacted></auth:token>");
    expect(envelope.transcript.raw_payload).toContain('"authorization":"<redacted>"');
    expect(envelope.transcript.raw_payload).toContain("Authorization: <redacted>");
    expect(envelope.transcript.raw_payload).toContain("https://cdn.example/t?lang=en");
    expect(envelope.transcript.source_payload_sha256).not.toBe(envelope.transcript.archived_payload_sha256);
  });
});
