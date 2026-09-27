// A real-SQLite stand-in for the D1 binding (node:sqlite), loaded with
// schema.sql -- for engine tests where the actual SQL semantics (UNIQUE,
// ON CONFLICT, RETURNING) are the thing under test.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

export function makeSqliteEnv() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../../schema.sql", import.meta.url), "utf8"));
  const prepare = (sql) => {
    let args = [];
    const q = {
      bind: (...a) => ((args = a.map((v) => (v === undefined ? null : v))), q),
      first: async () => db.prepare(sql).get(...args) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...args) }),
      run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    };
    return q;
  };
  return {
    db,
    DB: {
      prepare,
      batch: async (stmts) => {
        db.exec("BEGIN");
        try {
          const out = [];
          for (const s of stmts) out.push(await s.run());
          db.exec("COMMIT");
          return out;
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
      },
    },
  };
}
