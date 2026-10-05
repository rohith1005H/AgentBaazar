import { requireConsole } from "@/src/console/auth";
import { consoleData } from "@/src/console/console-data";
import { route } from "@/src/merchant/api/http";

export const GET = route(async () => {
	await requireConsole();
	return { status: 200, body: await consoleData(), headers: { "Cache-Control": "no-store" } };
});
