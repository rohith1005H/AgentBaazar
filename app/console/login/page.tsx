export const metadata = { title: "Sign in · AgentBaazar console", robots: { index: false } };

const ERRORS: Record<string, string> = {
	password: "That password is not right.",
	wait: "Too many attempts. Wait a minute and try again.",
};

export default async function ConsoleLogin(props: PageProps<"/console/login">) {
	const { error } = await props.searchParams;
	const message = typeof error === "string" ? ERRORS[error] : undefined;
	return (
		<main className="flex min-h-dvh items-center justify-center bg-paper px-5 text-ink">
			<form
				method="post"
				action="/api/console/login"
				className="w-full max-w-sm rounded-lg border border-rule bg-white p-6"
			>
				<p className="font-display text-[22px]">AgentBaazar</p>
				<h1 className="mt-1 text-[15px] text-ink/70">Merchant console: orders placed by AI shopping agents</h1>
				<label htmlFor="password" className="mt-6 block text-[14px] font-medium">
					Console password
				</label>
				<input
					id="password"
					name="password"
					type="password"
					required
					autoComplete="current-password"
					className="mt-1.5 h-11 w-full rounded-md border border-rule px-3 text-[16px] focus:border-indigo focus:outline-none"
				/>
				{message && <p className="mt-2 text-[14px] text-madder">{message}</p>}
				<button
					type="submit"
					className="mt-5 h-11 w-full rounded-md bg-ink text-[15px] font-medium text-white hover:bg-indigo"
				>
					Sign in
				</button>
			</form>
		</main>
	);
}
