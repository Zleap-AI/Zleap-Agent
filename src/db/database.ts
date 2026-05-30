import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { migrate } from "./schema";
import { seedDefaults } from "./seed";

export function openDatabase(filePath = process.env.ZLEAP_DB_PATH ?? "data/zleap.sqlite"): Database.Database {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new Database(resolved);
  migrate(db);
  seedDefaults(db);
  return db;
}
