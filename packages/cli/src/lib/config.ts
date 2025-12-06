import { z } from "zod";
import { cosmiconfig } from "cosmiconfig";
import type { CategoryName } from "../types.js";

const categorySchema = z.string() as z.ZodType<CategoryName>; // Allow string but typed as CategoryName

const sourceSchema = z.object({
  name: z.string().min(1, "Name is required"),
  url: z.string().url("Must be a valid URL"),
  category: categorySchema,
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(100).default(50),
});

const metaSchema = z
  .object({
    title: z.string().optional(),
    description: z.string().optional(),
    homepage: z.string().url().optional(),
    version: z.string().optional(),
    lastUpdated: z.string().optional(),
  })
  .optional();

const configSchema = z.object({
  meta: metaSchema,
  debug: z.boolean().default(false),
  mongodb: z
    .object({
      uri: z
        .string()
        .url()
        .default("mongodb://localhost:27017/blockingmachine"),
      options: z
        .object({
          maxPoolSize: z.number().int().positive().default(10),
        })
        .optional(),
    })
    .optional(),
  output: z
    .object({
      directory: z.string().default("./filters/output"),
    })
    .default({}),
  sources: z.array(sourceSchema).min(1, "At least one source is required"),
});

export type Config = z.infer<typeof configSchema>;

export async function loadConfig(): Promise<Config> {
  const explorer = cosmiconfig("blockingmachine");
  const result = await explorer.search();

  if (!result) {
    throw new Error("No configuration file found");
  }

  try {
    return configSchema.parse(result.config);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues
        .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      throw new Error(`Invalid configuration:\n${issues}`);
    }
    throw error;
  }
}
