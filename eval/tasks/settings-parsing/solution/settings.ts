export interface Settings {
  port: number;
  debug: boolean;
  retries: number;
  tags: string[];
}

const defaults: Settings = { port: 3000, debug: false, retries: 2, tags: [] };

/** Read settings from environment-style strings; unset values keep their defaults. */
export function parseSettings(env: Record<string, string | undefined>): Settings {
  return {
    port: env.PORT ? Number(env.PORT) : defaults.port,
    debug: env.DEBUG ? ["true", "1", "yes", "on"].includes(env.DEBUG.trim().toLowerCase()) : defaults.debug,
    retries: env.RETRIES ? Number(env.RETRIES) : defaults.retries,
    tags: env.TAGS ? env.TAGS.split(",").map((tag) => tag.trim()).filter(Boolean) : defaults.tags,
  };
}
