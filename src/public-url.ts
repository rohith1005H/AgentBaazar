/** Where this deployment is reachable: PUBLIC_URL, else Render's own URL, else local dev. */
export const publicUrl = () => process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:3000";
