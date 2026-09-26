// Which graphs fit a task, judged by the words they share.
//
// Deliberately plain: no model call, no embeddings — the entry view asks this
// on every keystroke, and the answer only has to be good enough to put three
// candidates next to the field. The graph picker stays the full answer.
import type { Graph } from "./graph";

/** Words too common to say anything about which graph fits. */
const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "what",
  "have", "will", "should", "about", "make", "then", "them", "they",
]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 4 && !STOP.has(word));
}

/**
 * Up to `limit` graphs whose name, example task or description share words
 * with `task`, best first. A graph sharing nothing is never suggested — an
 * empty row says more than a random one.
 */
export function suggestGraphs(graphs: Graph[], task: string, limit = 3): Graph[] {
  const wanted = new Set(words(task));
  if (wanted.size === 0) return [];
  return graphs
    .map((graph) => {
      const haystack = new Set(
        words(`${graph.name} ${graph.example} ${graph.description}`),
      );
      let score = 0;
      for (const word of wanted) {
        if (haystack.has(word)) score += 1;
        // A stem match ("refactor" in "refactoring") counts for half.
        else if ([...haystack].some((entry) => entry.startsWith(word) || word.startsWith(entry))) {
          score += 0.5;
        }
      }
      return { graph, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.graph);
}
