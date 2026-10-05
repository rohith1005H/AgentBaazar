import { redirect } from "next/navigation";
import { consoleAuthorized } from "@/src/console/auth";
import ConsoleClient from "@/src/console/console-client";

export const metadata = { title: "Merchant console · AgentBaazar", robots: { index: false } };

export default async function ConsolePage() {
	if (!(await consoleAuthorized())) redirect("/console/login");
	return <ConsoleClient />;
}
