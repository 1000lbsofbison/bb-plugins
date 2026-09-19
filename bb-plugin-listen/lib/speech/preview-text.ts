/**
 * The sentence the settings page's Preview button speaks.
 *
 * It has to be in the voice's own language. Every voice here phonemizes with
 * espeak-ng data for its language, so a German voice handed English text does
 * not read English with an accent — it reads the English letters as German
 * graphemes and produces something nobody can follow. The same holds for
 * Russian, Arabic or Mandarin, only more so: those voices have no phonemes
 * for Latin prose at all.
 */

/**
 * One sample per language in the voice catalog, each saying roughly the same
 * thing as the English one. Keyed by the primary subtag, because the catalog
 * mixes plain tags ("de") with regional ones ("de-DE", "pt-BR").
 */
export const PREVIEW_SAMPLES: Record<string, string> = {
  en: "This is how answers will sound when Listen reads them aloud.",
  de: "So klingen die Antworten, wenn Listen sie dir vorliest.",
  fr: "Voici comment les réponses sonneront quand Listen vous les lira.",
  es: "Así sonarán las respuestas cuando Listen te las lea en voz alta.",
  it: "Ecco come suoneranno le risposte quando Listen te le leggerà ad alta voce.",
  pt: "É assim que as respostas vão soar quando o Listen as ler em voz alta.",
  nl: "Zo klinken de antwoorden wanneer Listen ze voorleest.",
  ru: "Так будут звучать ответы, когда Listen прочитает их вслух.",
  tr: "Listen yanıtları sesli okuduğunda kulağa böyle gelecek.",
  ar: "هكذا ستبدو الإجابات عندما يقرأها Listen بصوت عالٍ.",
  zh: "这就是 Listen 朗读回答时的声音。",
  ja: "Listen が回答を読み上げると、このように聞こえます。",
  ko: "Listen이 답변을 읽어 줄 때는 이렇게 들립니다.",
  hi: "जब Listen उत्तर पढ़कर सुनाएगा, तो वह ऐसा सुनाई देगा।",
};

/** Falls back to English for a language we have no sample for. */
export const FALLBACK_LANGUAGE = "en";

/** "de-DE" and "de" both key the German sample. */
function primarySubtag(tag: string): string {
  return tag.trim().toLowerCase().split(/[-_]/)[0] ?? "";
}

/**
 * A multilingual model names its language inside the voice label, e.g.
 * "ff_siwis (fr, female)" or "af_heart (en-US, female)" — the only place the
 * per-voice language survives into the settings page's view of the catalog.
 */
function languageFromVoiceName(name: string): string | null {
  for (const part of name.matchAll(/\(([^)]*)\)/g)) {
    for (const field of part[1].split(",")) {
      const tag = primarySubtag(field);
      if (tag in PREVIEW_SAMPLES) return tag;
    }
  }
  return null;
}

/** A voice model as the settings page knows it — the part that matters here. */
export interface PreviewVoiceModel {
  languages: string[];
  voices: { sid: number; name: string }[];
}

/**
 * The language a preview of `sid` should be spoken in.
 *
 * Single-language models answer from `languages`; a multilingual one has to
 * ask the chosen voice, since sid 33 of Kokoro is French and sid 0 is English.
 */
export function previewLanguage(
  model: PreviewVoiceModel | null | undefined,
  sid: number | null,
): string {
  if (!model) return FALLBACK_LANGUAGE;

  const known = model.languages
    .map(primarySubtag)
    .filter((tag) => tag in PREVIEW_SAMPLES);

  if (known.length === 1) return known[0];

  if (known.length > 1 && sid !== null) {
    const voice = model.voices.find((candidate) => candidate.sid === sid);
    const fromName = voice ? languageFromVoiceName(voice.name) : null;
    if (fromName !== null) return fromName;
  }

  // Either no usable tag, or a multilingual model whose voice we could not
  // place: English is the one every model here speaks.
  return known.includes(FALLBACK_LANGUAGE) || known.length === 0
    ? FALLBACK_LANGUAGE
    : known[0];
}

/** The sentence to synthesize for a preview of `sid` in `model`. */
export function previewText(
  model: PreviewVoiceModel | null | undefined,
  sid: number | null,
): string {
  const language = previewLanguage(model, sid);
  return PREVIEW_SAMPLES[language] ?? PREVIEW_SAMPLES[FALLBACK_LANGUAGE];
}
