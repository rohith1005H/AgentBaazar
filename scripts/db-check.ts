/** Quick connectivity + schema check: `pnpm db:check` */
import { neon } from "@neondatabase/serverless";

async function main() {
	const url = process.env.DATABASE_URL;
	if (!url) throw new Error("DATABASE_URL not set (run via `neon-env run -- pnpm db:check` or export it)");
	const sql = neon(url);
	const rows = (await sql`
		select table_schema, string_agg(table_name, ', ' order by table_name) as tables
		from information_schema.tables where table_schema in ('merchant','platform')
		group by 1 order by 1`) as { table_schema: string; tables: string }[];
	for (const r of rows) console.log(`${r.table_schema}: ${r.tables}`);
	if (rows.length !== 2) throw new Error("expected schemas merchant and platform");
}
main().catch((e) => {
	console.error(e);
	process.exit(1);
});
