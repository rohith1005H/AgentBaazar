import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	// Baseline hardening for every response. No CSP: Next's inline scripts and AG Studio's
	// runtime CSS injection would need nonces; ponytail: add a nonce-based CSP if we harden further.
	headers() {
		return [
			{
				source: "/(.*)",
				headers: [
					{ key: "X-Content-Type-Options", value: "nosniff" },
					{ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
					{ key: "X-Frame-Options", value: "DENY" },
					{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
					{ key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
				],
			},
		];
	},
};

export default nextConfig;
