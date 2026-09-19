/**
 * Condensing an answer with an OpenAI-compatible chat endpoint.
 *
 * The alternative to spawning a hidden BB thread. That thread runs the
 * project's real agent — a coding model with tools and a large context — to
 * turn one message into three sentences. It works everywhere without setup,
 * but it costs tokens and seconds for a job a small model does in about one.
 *
 * Deliberately *not* an Ollama client. `/v1/chat/completions` is the one
 * shape that Ollama, LM Studio, llama.cpp's server, vLLM, Groq, OpenRouter
 * and most company proxies all speak, so a single setting covers "the model
 * on my laptop" and "the endpoint my team runs" without this file knowing
 * which is which.
 */

export interface CondenseApiOptions {
  /** Base URL including the version, e.g. http://127.0.0.1:11434/v1 */
  url: string;
  model: string;
  /** Sent as a bearer token when set; local servers usually need none. */
  apiKey?: string;
  /** Give up after this long; the caller then falls back. */
  timeoutMs?: number;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

export class CondenseApiError extends Error {
  /** True when nothing answered at all, as opposed to answering badly. */
  readonly unreachable: boolean;
  constructor(message: string, unreachable = false) {
    super(message);
    this.name = "CondenseApiError";
    this.unreachable = unreachable;
  }
}

/**
 * Ask the endpoint to condense `answer` using `prompt`.
 *
 * Throws rather than returning null, so the caller can report *why* it fell
 * back. A silently ignored misconfiguration is how a feature looks broken
 * while behaving exactly as written.
 */
export async function condenseWithApi(
  prompt: string,
  answer: string,
  options: CondenseApiOptions,
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(`${trimSlash(options.url)}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.apiKey === undefined || options.apiKey === ""
          ? {}
          : { authorization: `Bearer ${options.apiKey}` }),
      },
      body: JSON.stringify({
        model: options.model,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: answer },
        ],
        // Generous on purpose. Two sentences need a fraction of this, but a
        // reasoning model spends the budget on thinking first and returns an
        // empty message when it runs out — measured with gemma4:12b, which
        // produced nothing at all at 300. Models that do not think stop on
        // their own well before this, so the ceiling costs them nothing.
        max_tokens: 1200,
        temperature: 0.2,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      throw new CondenseApiError(describeStatus(response.status, options.model, detail));
    }

    const body = (await response.json()) as {
      choices?: {
        finish_reason?: unknown;
        message?: { content?: unknown; reasoning?: unknown };
      }[];
    };
    const choice = body.choices?.[0];
    const content = choice?.message?.content;
    const text = typeof content === "string" ? stripReasoning(content).trim() : "";

    if (text === "") {
      // A reasoning model that ran out of budget leaves an empty message with
      // its thinking beside it. Saying "empty summary" would send the user
      // looking in the wrong place; the fix is a bigger budget or a model
      // that does not think.
      const thought = choice?.message?.reasoning;
      if (typeof thought === "string" && thought.trim() !== "") {
        throw new CondenseApiError(
          `"${options.model}" spent its whole answer on reasoning and returned no summary. Use a model that does not think out loud, or raise the limit.`,
        );
      }
      throw new CondenseApiError("The summarizer returned an empty summary.");
    }
    return text;
  } catch (cause) {
    if (cause instanceof CondenseApiError) throw cause;
    if (controller.signal.aborted) {
      throw new CondenseApiError(
        `The summarizer did not answer within ${Math.round(timeoutMs / 1000)}s.`,
      );
    }
    // fetch rejects with a TypeError when nothing is listening — by far the
    // most common case, and the one with an actionable message.
    throw new CondenseApiError(
      `Could not reach the summarizer at ${options.url}. Is it running?`,
      true,
    );
  } finally {
    clearTimeout(timer);
  }
}

function describeStatus(status: number, model: string, detail: string): string {
  if (status === 404) {
    return `The summarizer does not have a model called "${model}" (or the URL has no /chat/completions under it).`;
  }
  if (status === 401 || status === 403) {
    return "The summarizer rejected the API key.";
  }
  return `The summarizer answered ${status}${detail === "" ? "" : `: ${detail}`}`;
}

/**
 * Drop a reasoning preamble.
 *
 * Small local models are increasingly reasoning models, and they put their
 * thinking in `<think>…</think>` ahead of the answer. Speaking that aloud
 * would be worse than speaking the raw reply.
 */
function stripReasoning(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/gi, "");
}

function trimSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
