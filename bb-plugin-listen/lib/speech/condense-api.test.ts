/**
 * Tests for the API condensing path.
 *
 * Every failure here ends the same way for the user — the full answer is read
 * instead of a summary — so what matters is that each cause produces a
 * message naming what to fix, rather than one generic shrug.
 */

import { describe, expect, it, vi } from "vitest";
import { condenseWithApi, CondenseApiError } from "./condense-api";

const prompt = "Summarize this for speech:";
const answer = "I fixed the failing test and pushed the change.";
const local = { url: "http://127.0.0.1:11434/v1", model: "llama3.2:latest" };

function respondWith(body: unknown, init: { status?: number; text?: string } = {}) {
  const status = init.status ?? 200;
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => init.text ?? JSON.stringify(body),
  })) as unknown as typeof fetch;
}

function completion(content: string) {
  return { choices: [{ message: { content } }] };
}

describe("condenseWithApi", () => {
  it("returns the summary the endpoint produced", async () => {
    const fetchImpl = respondWith(completion("  The test passes now.  "));
    await expect(
      condenseWithApi(prompt, answer, { ...local, fetchImpl }),
    ).resolves.toBe("The test passes now.");
  });

  it("posts prompt and answer as system and user messages", async () => {
    const fetchImpl = respondWith(completion("Done."));
    await condenseWithApi(prompt, answer, {
      url: "http://127.0.0.1:1234/v1/",
      model: "qwen2.5-3b",
      fetchImpl,
    });

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    // The trailing slash in the configured URL must not double up.
    expect(url).toBe("http://127.0.0.1:1234/v1/chat/completions");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe("qwen2.5-3b");
    expect(body.messages).toEqual([
      { role: "system", content: prompt },
      { role: "user", content: answer },
    ]);
    // Streaming would make the caller assemble chunks for no benefit.
    expect(body.stream).toBe(false);
  });

  it("sends no authorization header to a local server", async () => {
    const fetchImpl = respondWith(completion("Done."));
    await condenseWithApi(prompt, answer, { ...local, fetchImpl });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect((init as RequestInit).headers).not.toHaveProperty("authorization");
  });

  it("sends the API key as a bearer token when there is one", async () => {
    const fetchImpl = respondWith(completion("Done."));
    await condenseWithApi(prompt, answer, { ...local, apiKey: "sk-test", fetchImpl });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({
      authorization: "Bearer sk-test",
    });
  });

  it("drops a reasoning model's thinking before it can be spoken", async () => {
    const fetchImpl = respondWith(
      completion("<think>The user wants it short.</think>\nThe test passes now."),
    );
    await expect(
      condenseWithApi(prompt, answer, { ...local, fetchImpl }),
    ).resolves.toBe("The test passes now.");
  });

  it("says nothing is listening when the connection fails", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    await expect(
      condenseWithApi(prompt, answer, { ...local, fetchImpl }),
    ).rejects.toMatchObject({ unreachable: true, message: /Is it running/ });
  });

  it("names the model on a 404", async () => {
    const fetchImpl = respondWith({}, { status: 404, text: "model not found" });
    await expect(
      condenseWithApi(prompt, answer, { ...local, fetchImpl }),
    ).rejects.toThrow(/llama3\.2:latest/);
  });

  it("points at the key on a 401", async () => {
    const fetchImpl = respondWith({}, { status: 401 });
    await expect(
      condenseWithApi(prompt, answer, { ...local, apiKey: "wrong", fetchImpl }),
    ).rejects.toThrow(/API key/);
  });

  it("reports other HTTP failures with their status", async () => {
    const fetchImpl = respondWith({}, { status: 500, text: "boom" });
    await expect(
      condenseWithApi(prompt, answer, { ...local, fetchImpl }),
    ).rejects.toThrow(/500/);
  });

  it("refuses an empty summary instead of speaking nothing", async () => {
    const fetchImpl = respondWith(completion("   "));
    await expect(
      condenseWithApi(prompt, answer, { ...local, fetchImpl }),
    ).rejects.toThrow(CondenseApiError);
  });

  it("refuses a reply in a shape it does not understand", async () => {
    // A wrong URL often answers 200 with something else entirely.
    const fetchImpl = respondWith({ message: "hello from some other API" });
    await expect(
      condenseWithApi(prompt, answer, { ...local, fetchImpl }),
    ).rejects.toThrow(CondenseApiError);
  });

  it("gives up after the timeout rather than holding the answer back", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    ) as unknown as typeof fetch;

    await expect(
      condenseWithApi(prompt, answer, { ...local, timeoutMs: 20, fetchImpl }),
    ).rejects.toThrow(/did not answer/);
  });
});
