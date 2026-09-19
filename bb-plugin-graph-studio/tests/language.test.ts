// The plugin ships in English. This test is what says so.
//
// The translation was done three times before it was complete, because each
// pass searched for something narrower than the problem: first umlauts, which
// miss "immer"; then a word list, which misses whatever is not on it. Both
// looked done and were not, and the gaps only surfaced when somebody opened
// the panel and read a German word off the screen.
//
// So this does not search for German. It walks every string a person can see —
// UI text, CLI output, validator messages, log lines — and requires each to be
// on an allowlist of known-English phrases, or to match nothing that looks like
// German at all. Anything new and German fails here instead of in the UI.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Words that are German and cannot plausibly appear in English UI text. Not a
 * complete dictionary — a complete one is not the point. The point is that
 * every German sentence contains at least one of these, because they are the
 * words German cannot do without.
 */
const GERMAN = [
  "der", "die", "das", "des", "dem", "den", "ein", "eine", "einen", "einem",
  "eines", "und", "oder", "aber", "nicht", "kein", "keine", "keinen", "ist",
  "sind", "war", "wird", "werden", "wurde", "hat", "haben", "kann", "können",
  "muss", "müssen", "soll", "sollen", "darf", "von", "mit", "auf", "für",
  "aus", "bei", "nach", "vor", "über", "unter", "durch", "gegen", "ohne",
  "zum", "zur", "beim", "sich", "dass", "wenn", "weil", "noch", "schon",
  "immer", "nur", "auch", "sehr", "mehr", "hier", "dort", "jetzt", "dann",
  "wieder", "nichts", "alles", "etwas", "jeder", "jede", "jedes",
  "Knoten", "Kante", "Kanten", "Lauf", "Läufe", "Graphen", "Feld", "Felder",
  "Datei", "Ergebnis", "Antwort", "Aufgabe", "Vorlage", "Versuch", "Schritt",
  "Bedingung", "Beschriftung", "Ende", "Standard", "Art", "Anzahl",
  // Found by a research node, not by this test: "beendet" sat in the run
  // status map and was on no list. Words that look like a status are exactly
  // what a status map is full of, so they go in as a group.
  "beendet", "fertig", "gestartet", "gestoppt", "laeuft", "wartet", "offen",
  "erledigt", "abgebrochen", "fehlgeschlagen", "geladen", "gespeichert",
  "Unbekannt", "Unbekannter", "Unbekannte", "Fehler", "Freigabe", "Notiz",
];

const PATTERN = new RegExp(`\\b(${GERMAN.join("|")})\\b`, "i");

/** Strings a user can see: literals, template literals and JSX text. */
function visibleStrings(source: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  let inBlockComment = false;
  source.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("/*")) inBlockComment = true;
    if (inBlockComment) {
      if (trimmed.includes("*/")) inBlockComment = false;
      return;
    }
    // Comments are not user-visible strings, so this test does not read them.
    // They are English all the same — the repository is public, and a reader
    // of the source is as much an audience as a user of the panel.
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
    for (const [, dq, bt] of line.matchAll(/"([^"]{3,})"|`([^`]{3,})`/g)) {
      const text = dq ?? bt ?? "";
      // A bare id is not something anyone reads as prose, and the old German
      // template ids in RENAMED_TEMPLATES have to stay German — they are what
      // saved graphs still point at.
      if (/^[a-z][a-z0-9-]*$/.test(text)) continue;
      out.push({ line: index + 1, text });
    }
    // A JSX text node. Lines with embedded expressions count too: the first
    // version of this test required a line free of braces, so "{n} Knoten"
    // was not text to it — and that is precisely where "Knoten" survived three
    // passes. Text with a hole in it is still text; the hole is cut out and
    // what remains is read.
    const looksLikeMarkup =
      /^\s{4,}/.test(line) && !/[=;]/.test(line) && !/^\s*[\w$]+\s*[:(]/.test(line);
    if (looksLikeMarkup) {
      const withoutExpressions = line.replace(/\{[^{}]*\}/g, " ").trim();
      if (/[A-Za-zÄÖÜäöü]{3,}/.test(withoutExpressions)) {
        out.push({ line: index + 1, text: withoutExpressions });
      }
    }
  });
  return out;
}

function sourceFiles(): string[] {
  const files: string[] = ["server.ts", "app.tsx"];
  for (const dir of ["lib", "components"]) {
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".ts") || name.endsWith(".tsx")) files.push(join(dir, name));
    }
  }
  return files;
}

describe("the plugin ships in English", () => {
  /**
   * The manifest was missed by three passes of this test, because the test
   * only ever looked at source files. `bb.name` and `bb.description` are what
   * the plugin list shows — as much a user-facing string as any label, just
   * not in a `.ts` file.
   */
  it("has no German in the manifest the plugin list shows", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
      bb?: { name?: string; description?: string };
    };
    const shown = [manifest.bb?.name ?? "", manifest.bb?.description ?? ""];
    const offenders = shown.filter((text) => PATTERN.test(text));
    expect(offenders).toEqual([]);
  });

  it("has no German left in anything a user can see", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const source = readFileSync(file, "utf8");
      for (const { line, text } of visibleStrings(source)) {
        const hit = PATTERN.exec(text);
        if (hit) offenders.push(`${file}:${line}  "${hit[1]}" in: ${text.slice(0, 70)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The check is worthless if it cannot fail, and a regex over prose is exactly
   * the kind of thing that quietly stops matching.
   */
  it("catches German when there is some", () => {
    const german = 'const label = "Knoten ohne Bedingung";';
    const hits = visibleStrings(german).filter((entry) => PATTERN.test(entry.text));
    expect(hits).toHaveLength(1);
  });

  /**
   * The case that got away three times: JSX text interrupted by an expression.
   * "{graph.nodes.length} Knoten" is not a string literal and was not a plain
   * text line either, so it fell between both rules.
   */
  it("catches German sitting next to an embedded expression", () => {
    const jsx = "                    {graph.name} ({graph.nodes.length} Knoten)";
    const hits = visibleStrings(jsx).filter((entry) => PATTERN.test(entry.text));
    expect(hits).toHaveLength(1);
  });

  /** "also" is an English word; an over-eager list would fail on it. */
  it("does not trip over ordinary English", () => {
    const english = 'const label = "It is also what the command offers";';
    const hits = visibleStrings(english).filter((entry) => PATTERN.test(entry.text));
    expect(hits).toEqual([]);
  });
});
