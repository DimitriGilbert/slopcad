// @vitest-environment node
/**
 * The part-renderer decoder tests (PLAN-AGENT-CHAT Phase 4.3): the pure
 * decode layer over untrusted part payloads — the readable command summaries
 * (parsed by the domain's own strict `parseCommand`), the capture-view angle
 * labels, the capture gallery captioning (the Phase 2.3 bridge's summary
 * contract), and the media-source URL guards. Rendering itself is presentational
 * and verified in the Phase 6 browser walk; these tests pin the DECODING.
 */

import { describe, expect, it } from "vitest";
import {
  CAD_DOCUMENT_FORMAT_VERSION,
  length,
  serializeCommand,
} from "@slopcad/cad-core";
import { createParameterId, setParameterCommand } from "@slopcad/cad-react";

import {
  decodeApplyCommandsInput,
  decodeCaptureGallery,
  decodeCaptureViewsInput,
  formatCadCommand,
  mediaSourceSrc,
  parseLooseJson,
  stableJson,
} from "./decoders";

/** The serialized wire form of one typed command, as the tool input carries it. */
function serialized(command: Parameters<typeof serializeCommand>[0]): unknown {
  return serializeCommand(command);
}

describe("formatCadCommand", () => {
  it("summarizes a value-only parameter.set with its serialized quantity", () => {
    const command = setParameterCommand(
      createParameterId("param_width"),
      length(33),
    );
    expect(formatCadCommand(command)).toBe("Set param_width = 33 mm");
  });

  it("summarizes a define-form parameter.set through the printed expression", () => {
    const input = {
      expression: { kind: "identifier", name: "height" },
      formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
      id: "param_width",
      type: "parameter.set",
    };
    const decoded = decodeApplyCommandsInput({ commands: [input] });
    expect(decoded?.commands[0]?.ok).toBe(true);
    if (decoded?.commands[0]?.ok === true) {
      expect(formatCadCommand(decoded.commands[0].command)).toBe(
        "Set param_width = height",
      );
    }
  });

  it("summarizes reorder-to-front and body updates readably", () => {
    const reorder = decodeApplyCommandsInput({
      commands: [
        {
          afterFeatureId: null,
          formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
          id: "feat_2",
          type: "feature.reorder",
        },
      ],
    });
    expect(reorder?.commands[0]?.ok).toBe(true);
    if (reorder?.commands[0]?.ok === true) {
      expect(formatCadCommand(reorder.commands[0].command)).toBe(
        "Move feature feat_2 after the timeline start",
      );
    }

    const bodyUpdate = decodeApplyCommandsInput({
      commands: [
        {
          formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
          id: "body_1",
          name: "Mounting plate",
          type: "body.update",
          visible: false,
        },
      ],
    });
    expect(bodyUpdate?.commands[0]?.ok).toBe(true);
    if (bodyUpdate?.commands[0]?.ok === true) {
      expect(formatCadCommand(bodyUpdate.commands[0].command)).toBe(
        'Update body body_1: name "Mounting plate", hide',
      );
    }
  });
});

describe("decodeApplyCommandsInput", () => {
  it("parses every entry with the domain's strict parser", () => {
    const good = serialized(
      setParameterCommand(createParameterId("param_d"), length(7)),
    );
    const decoded = decodeApplyCommandsInput({
      commands: [good, { type: "parameter.set", nope: true }],
    });
    expect(decoded).not.toBeNull();
    expect(decoded?.commands).toHaveLength(2);
    expect(decoded?.commands[0]?.ok).toBe(true);
    const refused = decoded?.commands[1];
    expect(refused?.ok).toBe(false);
    if (refused?.ok === false) {
      expect(refused.message.length).toBeGreaterThan(0);
    }
  });

  it("returns null for inputs that are not the { commands } shape", () => {
    expect(decodeApplyCommandsInput(undefined)).toBeNull();
    expect(decodeApplyCommandsInput({ commands: "nope" })).toBeNull();
    expect(decodeApplyCommandsInput([])).toBeNull();
  });
});

describe("decodeCaptureViewsInput", () => {
  it("labels presets by name and arbitrary angles as a pair", () => {
    const views = decodeCaptureViewsInput({
      views: [{ preset: "front" }, { azimuth: 45, elevation: 30 }],
    });
    expect(views).toEqual([
      { label: "front" },
      { label: "az 45\u00b0 / el 30\u00b0" },
    ]);
  });

  it("returns null for malformed view entries or shapes", () => {
    expect(
      decodeCaptureViewsInput({ views: [{ preset: "front" }, {}] }),
    ).toBeNull();
    expect(decodeCaptureViewsInput({ views: "front" })).toBeNull();
    expect(decodeCaptureViewsInput({})).toBeNull();
  });
});

describe("decodeCaptureGallery", () => {
  const image = () => ({
    type: "image" as const,
    source: {
      type: "data" as const,
      value: "aGk=",
      mimeType: "image/png",
    },
  });

  it("recovers per-view captions from the bridge's summary line", () => {
    const gallery = decodeCaptureGallery([
      { type: "text", content: "Captured 2 views: front, iso." },
      image(),
      image(),
    ]);
    expect(gallery.summary).toBe("Captured 2 views: front, iso.");
    expect(gallery.images.map((entry) => entry.caption)).toEqual([
      "front",
      "iso",
    ]);
    expect(gallery.images[0]?.src).toBe("data:image/png;base64,aGk=");
  });

  it("falls back to positional captions for other producers", () => {
    const gallery = decodeCaptureGallery([
      { type: "text", content: "Here is the render." },
      image(),
      image(),
    ]);
    expect(gallery.images.map((entry) => entry.caption)).toEqual([
      "View 1 of 2",
      "View 2 of 2",
    ]);
  });

  it("passes a plain string content through as the summary", () => {
    expect(decodeCaptureGallery("done")).toEqual({
      images: [],
      summary: "done",
    });
  });
});

describe("mediaSourceSrc", () => {
  it("builds data URIs for inline sources and delegates URL safety to the shared guard", () => {
    expect(
      mediaSourceSrc({ type: "data", value: "aGk=", mimeType: "image/png" }),
    ).toBe("data:image/png;base64,aGk=");
    expect(mediaSourceSrc({ type: "url", value: "https://x.test/a.png" })).toBe(
      "https://x.test/a.png",
    );
    expect(mediaSourceSrc({ type: "url", value: "http://x.test/a.png" })).toBe(
      "http://x.test/a.png",
    );
    expect(
      mediaSourceSrc({ type: "url", value: "javascript:alert(1)" }),
    ).toBeNull();
    expect(mediaSourceSrc({ type: "url", value: "not a url" })).toBeNull();
    expect(mediaSourceSrc({ type: "file", value: "file-abc" })).toBeNull();
  });

  it("refuses parseable non-http URL schemes through the shared guard", () => {
    expect(
      mediaSourceSrc({ type: "url", value: "ftp://x.test/a.png" }),
    ).toBeNull();
    expect(
      mediaSourceSrc({
        type: "url",
        value: "data:text/html,<script>x</script>",
      }),
    ).toBeNull();
  });
});

describe("json display helpers", () => {
  it("parses loose JSON for the raw fallbacks", () => {
    expect(parseLooseJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseLooseJson("{partial")).toBeUndefined();
    expect(parseLooseJson("")).toBeUndefined();
  });

  it("stringifies untyped payloads deterministically", () => {
    expect(stableJson({ b: 1, a: 2 })).toBe('{\n  "b": 1,\n  "a": 2\n}');
    expect(stableJson(undefined)).toBe("undefined");
  });
});
