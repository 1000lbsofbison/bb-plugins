import { describe, expect, it } from "vitest";
import {
  PREVIEW_SAMPLES,
  previewLanguage,
  previewText,
  type PreviewVoiceModel,
} from "./preview-text.js";

const german: PreviewVoiceModel = {
  languages: ["de-DE"],
  voices: [{ sid: 0, name: "Piper Thorsten (de-DE)" }],
};

const kokoro: PreviewVoiceModel = {
  languages: ["en", "zh", "ja", "ko", "es", "fr", "hi", "it", "pt"],
  voices: [
    { sid: 0, name: "af_heart (en-US, female)" },
    { sid: 33, name: "ff_siwis (fr, female)" },
    { sid: 48, name: "zf_xiaobei (zh, female)" },
    { sid: 99, name: "mystery voice" },
  ],
};

describe("previewLanguage", () => {
  it("takes the language of a single-language model", () => {
    expect(previewLanguage(german, 0)).toBe("de");
  });

  it("does not fall back to English for a non-English model", () => {
    expect(previewLanguage(german, 0)).not.toBe("en");
  });

  it("reads the language out of the voice label of a multilingual model", () => {
    expect(previewLanguage(kokoro, 33)).toBe("fr");
    expect(previewLanguage(kokoro, 48)).toBe("zh");
    expect(previewLanguage(kokoro, 0)).toBe("en");
  });

  it("falls back to English when a multilingual voice names no language", () => {
    expect(previewLanguage(kokoro, 99)).toBe("en");
  });

  it("falls back to English for an unknown model or an unknown tag", () => {
    expect(previewLanguage(null, 0)).toBe("en");
    expect(previewLanguage({ languages: ["xx-YY"], voices: [] }, 0)).toBe("en");
  });
});

describe("previewText", () => {
  it("speaks German to a German voice", () => {
    expect(previewText(german, 0)).toBe(PREVIEW_SAMPLES.de);
  });

  it("never hands a non-English voice the English sample", () => {
    expect(previewText(german, 0)).not.toBe(PREVIEW_SAMPLES.en);
    expect(previewText(kokoro, 33)).not.toBe(PREVIEW_SAMPLES.en);
  });

  it("speaks English when nothing better is known", () => {
    expect(previewText(null, null)).toBe(PREVIEW_SAMPLES.en);
  });

  it("has a sample for every language the catalog offers", () => {
    for (const tag of ["en", "de", "fr", "es", "it", "pt", "nl", "ru", "tr", "ar", "zh", "ja", "ko", "hi"]) {
      expect(PREVIEW_SAMPLES[tag], tag).toBeTruthy();
    }
  });
});
