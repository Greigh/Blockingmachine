import { StoredRuleModel } from "../lib/db.js";
import { createLogger } from "../lib/logger.js";
import type { CategoryName, StoredRule } from "../types.js";

interface AggregationResult {
  _id: string;
  count: number;
}

interface ViewDatabaseOptions {
  sampleSize?: number;
  debug?: boolean;
}

export async function viewDatabase(
  options: ViewDatabaseOptions = {},
): Promise<void> {
  const logger = createLogger(options.debug);
  const sampleSize = options.sampleSize || 5;

  try {
    const ruleCount = await StoredRuleModel.countDocuments();

    const stats = {
      totalRules: ruleCount,
      ruleTypes: await getRuleTypeStats(),
      categories: await getCategoryStats(),
    };

    logger.info("📊 Database Statistics");
    console.table(stats);

    if (options.debug) {
      const sampleRules = await StoredRuleModel.find().limit(sampleSize).lean();
      logger.info("📝 Sample Rules");
      sampleRules.forEach(logRuleDetails);
    }
  } catch (error) {
    logger.error("Error viewing database:", error);
  }
}

async function getRuleTypeStats(): Promise<Record<string, number>> {
  const types = await StoredRuleModel.aggregate<AggregationResult>([
    { $group: { _id: "$type", count: { $sum: 1 } } },
  ]);
  return types.reduce((acc: Record<string, number>, { _id, count }) => {
    acc[_id] = count;
    return acc;
  }, {});
}

async function getCategoryStats(): Promise<Record<CategoryName, number>> {
  const categories = await StoredRuleModel.aggregate<AggregationResult>([
    { $group: { _id: "$metadata.sourceInfo.category", count: { $sum: 1 } } },
  ]);
  return categories.reduce(
    (acc: Record<CategoryName, number>, { _id, count }) => {
      acc[_id as CategoryName] = count;
      return acc;
    },
    {} as Record<CategoryName, number>,
  );
}

function logRuleDetails(rule: StoredRule): void {
  console.log("\nRule:", rule.raw);
  console.log("Domain:", rule.domain);
  console.log("Type:", rule.type);
  if (rule.metadata) {
    console.log("Sources:", rule.metadata.sources);
    console.log("Tags:", rule.metadata.tags);
  }
}
