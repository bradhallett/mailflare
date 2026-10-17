import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * RFC 8620 §5.3 turns `Email/set` update keys into RFC 6901 pointers, so the
 * `~` in Mailflare's role refs (`mbx_…~inbox`) arrives escaped as `~0` —
 * exactly what ByteMail sends when moving a message to Trash:
 *
 *   { "mailboxIds/mbx_…~0trash": true, "mailboxIds/mbx_…~0inbox": null }
 *
 * Without unescaping, the removal key never matches the current membership and
 * the set resolves to two mailboxes, rejected as "A message belongs to exactly
 * one mailbox". Everything runs against an in-memory SQLite database; no
 * Workers binding is touched.
 */
const outDir = mkdtempSync(join(root, "node_modules", "mailflare-jmap-patch-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { getDb } from "./src/db/index.ts";
			export { emailSet } from "./src/lib/jmap/emails.ts";
			export { encodeMailboxRef } from "./src/lib/jmap/ids.ts";
		`,
		resolveDir: root,
		sourcefile: "jmap-patch-test-entry.ts",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "next/headers": "next/headers.js", "next/server": "next/server.js", "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});

const { SqliteDatabase, applyMigrations, getDb, emailSet, encodeMailboxRef } = await import(
	pathToFileURL(join(outDir, "entry.mjs")).href
);

const MAILBOX = "mbx_test";

async function fixture(t) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES
			('admin', 'owner@one.test', 'hash', 'Owner', 'admin', 1, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES
			('one', 'admin', 'one.test', 'zone-one', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, display_name, use_all_domains, type, disabled, created_at) VALUES
			('${MAILBOX}', 'admin', 'one', 'support', 'Support', 1, 'personal', 0, 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, read, starred, created_at) VALUES
			('msg_keep', 'admin', '${MAILBOX}', 'inbound', 'a@one.test', 'support@one.test', 'received', 0, 0, 1),
			('msg_move', 'admin', '${MAILBOX}', 'inbound', 'b@one.test', 'support@one.test', 'received', 0, 0, 2);
	`);
	const env = { DB: database };
	const ctx = {
		env,
		db: getDb(env),
		auth: { userId: "admin", email: "owner@one.test", scopes: ["jmap"], mailboxIds: null, user: { id: "admin", email: "owner@one.test", role: "admin" } },
		accountId: "admin",
		origin: "http://test",
		createdIds: {},
	};
	return { database, ctx };
}

const status = (database, id) => database.db.prepare("SELECT status, folder_id, read FROM messages WHERE id = ?").get(id);

test("escaped role tokens move a message to Trash (RFC 6901 `~0`)", async (t) => {
	const { database, ctx } = await fixture(t);
	const trash = encodeMailboxRef({ kind: "role", mailboxId: MAILBOX, role: "trash" });
	const inbox = encodeMailboxRef({ kind: "role", mailboxId: MAILBOX, role: "inbox" });
	const escape = (token) => token.replaceAll("~", "~0");

	const result = await emailSet(ctx, {
		update: { msg_move: { [`mailboxIds/${escape(trash)}`]: true, [`mailboxIds/${escape(inbox)}`]: null } },
	});

	assert.deepEqual(result.notUpdated, {}, "the escaped patch must be accepted");
	assert.deepEqual(result.updated, { msg_move: null });
	assert.equal(status(database, "msg_move").status, "trash");
	assert.equal(status(database, "msg_keep").status, "received");
});

test("unescaped tokens with a removal key still move, and keywords unescape too", async (t) => {
	const { database, ctx } = await fixture(t);
	const trash = encodeMailboxRef({ kind: "role", mailboxId: MAILBOX, role: "trash" });
	const inbox = encodeMailboxRef({ kind: "role", mailboxId: MAILBOX, role: "inbox" });

	const result = await emailSet(ctx, {
		update: { msg_move: { [`mailboxIds/${trash}`]: true, [`mailboxIds/${inbox}`]: null, "keywords/$seen": true } },
	});

	assert.deepEqual(result.notUpdated, {});
	assert.equal(status(database, "msg_move").status, "trash");
	assert.equal(status(database, "msg_move").read, 1, "the `$seen` keyword patch must mark the message read");
});

test("`~1` decodes before `~0` so `~01` round-trips a literal `~1`", async (t) => {
	const { ctx } = await fixture(t);
	// A token Mailflare never issued must still be reported as an unknown
	// mailbox, not silently matched against a role ref.
	const result = await emailSet(ctx, {
		update: { msg_move: { "mailboxIds/mbx_test~01junk": true } },
	});
	assert.deepEqual(result.updated, {});
	assert.equal(result.notUpdated.msg_move.type, "invalidProperties");
});
