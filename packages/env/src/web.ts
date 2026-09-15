import { createEnv } from "@t3-oss/env-core";

const viteEnv = (
  import.meta as ImportMeta & {
    env?: Record<string, string | undefined>;
  }
).env;

export const env = createEnv({
  clientPrefix: "VITE_",
  client: {},
  runtimeEnv: viteEnv ?? {},
  emptyStringAsUndefined: true,
});
