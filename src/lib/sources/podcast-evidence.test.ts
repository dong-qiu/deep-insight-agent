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
        body_kind: "show_notes", raw: '{"rss":"entry"}',
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
      schema_version: "podcast-transcript-evidence-v1",
      episode: { url: "https://pod.example/episodes/1?lang=en", rss_item: '{"rss":"entry"}' },
      program_page: { stable_url: "https://pod.example/episodes/1?lang=en", raw_payload: "<html>episode page</html>" },
      transcript: { stable_url: "https://cdn.example/transcript?lang=en", raw_payload: "Speaker: original payload" },
    });
    expect(envelope.transcript.raw_payload_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(envelope.transcript.cleaned_body_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("does not strip a non-credential query parameter", () => {
    expect(stableEvidenceUrl("https://pod.example/t?format=vtt&signature=abc#cue"))
      .toBe("https://pod.example/t?format=vtt");
  });
});
