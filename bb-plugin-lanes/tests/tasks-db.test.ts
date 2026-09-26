import { afterEach, describe, expect, it } from "vitest";
import DatabaseConstructor from "better-sqlite3";
import {
  SUPPORTED_SCHEMA_VERSION,
  readProjects,
  readRevision,
  readSchemaVersion,
  readTasks,
  tasksDatabasePath,
} from "@/lib/tasks-db";
import {
  addLabel,
  attachThread,
  createTasksFixture,
  insertProject,
  insertTask,
  type Fixture,
} from "./fixture";

let fixture: Fixture | null = null;

afterEach(() => {
  fixture?.close();
  fixture = null;
});

function open(schemaVersions?: number[]): Fixture {
  fixture = createTasksFixture(schemaVersions);
  return fixture;
}

describe("tasksDatabasePath", () => {
  it("builds the path from BB's data dir, not from a guessed home", () => {
    expect(tasksDatabasePath("/srv/bb-data")).toBe(
      "/srv/bb-data/plugins/tasks/data.db",
    );
  });
});

describe("readSchemaVersion", () => {
  it("reads the highest applied migration", () => {
    const { db } = open();
    expect(readSchemaVersion(db)).toBe(SUPPORTED_SCHEMA_VERSION);
  });

  it("reads a version past the supported one, so it can be refused", () => {
    const { db } = open([1, 2, 3, 4, 5, 6, 7]);
    expect(readSchemaVersion(db)).toBeGreaterThan(SUPPORTED_SCHEMA_VERSION);
  });

  it("reads 0 from a database that has no schema_version table", () => {
    const db = new DatabaseConstructor(":memory:");
    expect(readSchemaVersion(db)).toBe(0);
    db.close();
  });
});

describe("readRevision", () => {
  it("starts at the stored value", () => {
    const { db } = open();
    expect(readRevision(db)).toBe(0);
  });

  // The counter is the whole reason for reading SQLite directly. If the tasks
  // plugin's triggers ever stop firing, this is where it shows.
  it("moves when a task is written", () => {
    const { db } = open();
    insertProject(db, { id: "prj_1", name: "Side", prefix: "SID" });
    const before = readRevision(db);
    insertTask(db, { id: "t1", projectId: "prj_1", number: 1, title: "One" });
    expect(readRevision(db)).toBeGreaterThan(before);
  });
});

describe("readProjects", () => {
  it("returns the tracker projects by name", () => {
    const { db } = open();
    insertProject(db, { id: "prj_2", name: "Beta", prefix: "BET" });
    insertProject(db, { id: "prj_1", name: "Alpha", prefix: "ALP" });
    expect(readProjects(db).map((project) => project.name)).toEqual([
      "Alpha",
      "Beta",
    ]);
  });

  it("returns nothing when no project exists", () => {
    const { db } = open();
    expect(readProjects(db)).toEqual([]);
  });
});

describe("readTasks", () => {
  it("builds the task key from the project prefix and the number", () => {
    const { db } = open();
    insertProject(db, { id: "prj_1", name: "Side", prefix: "SID" });
    insertTask(db, { id: "t1", projectId: "prj_1", number: 12, title: "One" });
    expect(readTasks(db, "prj_1")[0]?.key).toBe("SID-12");
  });

  it("returns only the asked-for project's tasks", () => {
    const { db } = open();
    insertProject(db, { id: "prj_1", name: "One", prefix: "ONE" });
    insertProject(db, { id: "prj_2", name: "Two", prefix: "TWO" });
    insertTask(db, { id: "t1", projectId: "prj_1", number: 1, title: "Mine" });
    insertTask(db, { id: "t2", projectId: "prj_2", number: 1, title: "Theirs" });
    expect(readTasks(db, "prj_1").map((task) => task.title)).toEqual(["Mine"]);
  });

  // Positive and negative for the live-thread flag, in the same file, so the
  // negative case cannot pass by the query returning nothing at all.
  it("flags a task whose attached thread is still working", () => {
    const { db } = open();
    insertProject(db, { id: "prj_1", name: "Side", prefix: "SID" });
    insertTask(db, { id: "t1", projectId: "prj_1", number: 1, title: "One" });
    attachThread(db, {
      id: "tt1",
      taskId: "t1",
      threadId: "thr_1",
      liveStatus: "working",
    });
    expect(readTasks(db, "prj_1")[0]?.liveThread).toBe(true);
  });

  it("does not flag a task whose attached thread already completed", () => {
    const { db } = open();
    insertProject(db, { id: "prj_1", name: "Side", prefix: "SID" });
    insertTask(db, { id: "t1", projectId: "prj_1", number: 1, title: "One" });
    attachThread(db, {
      id: "tt1",
      taskId: "t1",
      threadId: "thr_1",
      liveStatus: "completed",
    });
    const [task] = readTasks(db, "prj_1");
    expect(task?.key).toBe("SID-1");
    expect(task?.liveThread).toBe(false);
  });

  it("does not flag a task with no attached thread", () => {
    const { db } = open();
    insertProject(db, { id: "prj_1", name: "Side", prefix: "SID" });
    insertTask(db, { id: "t1", projectId: "prj_1", number: 1, title: "One" });
    expect(readTasks(db, "prj_1")[0]?.liveThread).toBe(false);
  });

  it("attaches a task's labels", () => {
    const { db } = open();
    insertProject(db, { id: "prj_1", name: "Side", prefix: "SID" });
    insertTask(db, { id: "t1", projectId: "prj_1", number: 1, title: "One" });
    addLabel(db, {
      id: "l1",
      projectId: "prj_1",
      taskId: "t1",
      name: "bug",
      color: "#ff0000",
    });
    expect(readTasks(db, "prj_1")[0]?.labels).toEqual([
      { name: "bug", color: "#ff0000" },
    ]);
  });

  it("leaves labels empty for a task that has none", () => {
    const { db } = open();
    insertProject(db, { id: "prj_1", name: "Side", prefix: "SID" });
    insertTask(db, { id: "t1", projectId: "prj_1", number: 1, title: "One" });
    insertTask(db, { id: "t2", projectId: "prj_1", number: 2, title: "Two" });
    addLabel(db, { id: "l1", projectId: "prj_1", taskId: "t1", name: "bug" });
    const byKey = new Map(readTasks(db, "prj_1").map((t) => [t.key, t]));
    expect(byKey.get("SID-1")?.labels).toHaveLength(1);
    expect(byKey.get("SID-2")?.labels).toEqual([]);
  });
});

describe("the schema is a contract, not a suggestion", () => {
  it("still rejects a status outside the six the board renders", () => {
    const { db } = open();
    insertProject(db, { id: "prj_1", name: "Side", prefix: "SID" });
    expect(() =>
      insertTask(db, {
        id: "t1",
        projectId: "prj_1",
        number: 1,
        title: "One",
        status: "blocked",
      }),
    ).toThrow();
  });
});
