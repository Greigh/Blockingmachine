import mongoose from "mongoose";
import type { StoredRule, MongoConfig } from "../types.js";

export async function connectDB(config: MongoConfig): Promise<void> {
  await mongoose.connect(config.uri, config.options);
}

export async function disconnectDB(): Promise<void> {
  await mongoose.disconnect();
}

const ruleSchema = new mongoose.Schema({
  raw: { type: String, required: true },
  type: { type: String, required: true },
  domain: String,
  hash: { type: String, required: true, unique: true },
  metadata: {
    sources: [String],
    dateAdded: { type: Date, default: Date.now },
    lastUpdated: { type: Date, default: Date.now },
    enabled: { type: Boolean, default: true },
    sourceInfo: {
      category: { type: String, required: true },
      trusted: { type: Boolean, default: false },
      url: String,
    },
    tags: [String],
  },
  variants: [
    {
      rule: String,
      source: String, // Changed from sourceId to source
      dateAdded: Date,
      modifiers: [String], // Changed from objects to simple strings
      tags: [String],
    },
  ],
});

export const StoredRuleModel = mongoose.model<StoredRule>("Rule", ruleSchema);
