import { describe, expect, it } from "vitest";
import { isSelectedForVoice, selectCommand, transcriptOrThrow } from "./ai-service.js";

describe("isSelectedForVoice", () => {
  it("is true when voice is pinned to this plugin's service", () => {
    expect(
      isSelectedForVoice({ mode: "service", pluginId: "listen", serviceId: "listen" }, "listen", "listen"),
    ).toBe(true);
  });

  it("is false for another plugin's service of the same id", () => {
    expect(
      isSelectedForVoice({ mode: "service", pluginId: "other", serviceId: "listen" }, "listen", "listen"),
    ).toBe(false);
  });

  it("is false for another service of this plugin", () => {
    expect(
      isSelectedForVoice({ mode: "service", pluginId: "listen", serviceId: "x" }, "listen", "listen"),
    ).toBe(false);
  });

  it("is false for automatic and off", () => {
    expect(isSelectedForVoice({ mode: "automatic" }, "listen", "listen")).toBe(false);
    expect(isSelectedForVoice({ mode: "off" }, "listen", "listen")).toBe(false);
  });
});

describe("selectCommand", () => {
  it("names the voice task and the service id", () => {
    expect(selectCommand("listen")).toBe("bb settings ai-services set voice listen");
  });
});

describe("transcriptOrThrow", () => {
  it("returns the text, including an empty transcript of silence", () => {
    expect(transcriptOrThrow({ text: "hello", error: null })).toBe("hello");
    expect(transcriptOrThrow({ text: "", error: null })).toBe("");
  });

  it("rejects with the host's message", () => {
    expect(() => transcriptOrThrow({ text: null, error: "Download the model first." })).toThrow(
      "Download the model first.",
    );
  });

  it("rejects with a fallback when the host gave no reason", () => {
    expect(() => transcriptOrThrow({ text: null, error: null })).toThrow(/without a reason/);
  });
});
