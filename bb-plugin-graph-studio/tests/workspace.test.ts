import { describe, expect, it } from "vitest";
import { isWorkspaceBusy, whileWorkspaceBusy } from "../lib/workspace";

/** What BB's plugin SDK actually throws: BbHttpError with status and code. */
function bbError(status: number, code: string, message = "broken") {
  return Object.assign(new Error(`HTTP ${status}: ${message}`), {
    status,
    code,
  });
}

/** A clock that only moves when the fake sleep is called. */
function fakeClock() {
  let t = 0;
  const slept: number[] = [];
  return {
    slept,
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
  };
}

describe("isWorkspaceBusy", () => {
  it("recognises BB's refusal", () => {
    expect(isWorkspaceBusy(bbError(409, "workspace_busy"))).toBe(true);
  });

  // Negative cases: everything that merely *looks* like it. If one of them
  // passed as "busy", a real error would sit out the two-minute deadline
  // instead of failing the node straight away.
  it("does not read another 409 as busy", () => {
    // Same status, different cause: the environment belongs to another project.
    expect(isWorkspaceBusy(bbError(409, "invalid_request"))).toBe(false);
  });

  it("does not read the same code under another status as busy", () => {
    expect(isWorkspaceBusy(bbError(500, "workspace_busy"))).toBe(false);
  });

  it("does not trip over errors without structure", () => {
    expect(isWorkspaceBusy(new Error("HTTP 409: workspace busy"))).toBe(false);
    expect(isWorkspaceBusy(null)).toBe(false);
    expect(isWorkspaceBusy("409")).toBe(false);
    expect(isWorkspaceBusy(undefined)).toBe(false);
  });
});

describe("whileWorkspaceBusy", () => {
  it("passes the result through when nothing is busy", async () => {
    let calls = 0;
    const clock = fakeClock();
    const result = await whileWorkspaceBusy(
      async () => {
        calls += 1;
        return "thr_1";
      },
      { sleep: clock.sleep, now: clock.now },
    );
    expect(result).toBe("thr_1");
    expect(calls).toBe(1);
    expect(clock.slept).toEqual([]);
  });

  it("waits out the gap and then spawns after all", async () => {
    // The real case: BB releases the environment ~500 ms after `idle`.
    let calls = 0;
    const clock = fakeClock();
    const result = await whileWorkspaceBusy(
      async () => {
        calls += 1;
        if (calls < 3) throw bbError(409, "workspace_busy");
        return "thr_critique";
      },
      { sleep: clock.sleep, now: clock.now, delayMs: 250 },
    );
    expect(result).toBe("thr_critique");
    expect(calls).toBe(3);
    expect(clock.slept).toEqual([250, 500]);
  });

  // Negative case: a foreign error must not trigger a single retry.
  it("rethrows every other error immediately", async () => {
    let calls = 0;
    const clock = fakeClock();
    await expect(
      whileWorkspaceBusy(
        async () => {
          calls += 1;
          throw bbError(404, "not_found", "No such environment.");
        },
        { sleep: clock.sleep, now: clock.now },
      ),
    ).rejects.toThrow("No such environment.");
    expect(calls).toBe(1);
    expect(clock.slept).toEqual([]);
  });

  // Negative case: permanently busy means failing, not waiting forever.
  it("gives up after the deadline and reports the last error", async () => {
    let calls = 0;
    const clock = fakeClock();
    await expect(
      whileWorkspaceBusy(
        async () => {
          calls += 1;
          throw bbError(409, "workspace_busy", "Working copy busy");
        },
        { sleep: clock.sleep, now: clock.now, delayMs: 250, timeoutMs: 1_000 },
      ),
    ).rejects.toThrow("Working copy busy");
    // 250 + 500 waited; the next pause (1000) no longer fits the deadline.
    expect(clock.slept).toEqual([250, 500]);
    expect(calls).toBe(3);
  });

  it("caps the pause instead of doubling it without end", async () => {
    const clock = fakeClock();
    await expect(
      whileWorkspaceBusy(async () => Promise.reject(bbError(409, "workspace_busy")), {
        sleep: clock.sleep,
        now: clock.now,
        delayMs: 1_000,
        maxDelayMs: 2_000,
        timeoutMs: 12_000,
      }),
    ).rejects.toThrow();
    // 1000 + 2000·5 = 11 000 waited; the sixth 2000 pause breaks the deadline.
    expect(clock.slept).toEqual([1_000, 2_000, 2_000, 2_000, 2_000, 2_000]);
  });

  it("reports every wait, so the run stays explainable", async () => {
    const seen: Array<[number, number]> = [];
    const clock = fakeClock();
    let calls = 0;
    await whileWorkspaceBusy(
      async () => {
        calls += 1;
        if (calls < 3) throw bbError(409, "workspace_busy");
        return "ok";
      },
      {
        sleep: clock.sleep,
        now: clock.now,
        delayMs: 250,
        onWait: (attempt, waited) => seen.push([attempt, waited]),
      },
    );
    expect(seen).toEqual([
      [1, 0],
      [2, 250],
    ]);
  });
});
