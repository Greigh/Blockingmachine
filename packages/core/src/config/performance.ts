export interface PerformanceConfig {
  caching: {
    enabled: boolean;
    ttl: number;
    maxSize: string;
  };
  processing: {
    batchSize: number;
    parallel: number;
    timeout: number;
  };
  optimization: {
    deduplication: {
      aggressive: boolean;
      preserveModifiers: boolean;
    };
    compression: {
      enabled: boolean;
      level: "balanced" | "aggressive" | "conservative";
    };
  };
}

/** Create independent, mutable performance settings for a compilation. */
export function createPerformance(): PerformanceConfig {
  return {
    caching: {
      enabled: true,
      ttl: 3600,
      maxSize: "100mb",
    },
    processing: {
      batchSize: 1000,
      parallel: 4,
      timeout: 30000,
    },
    optimization: {
      deduplication: {
        aggressive: false,
        preserveModifiers: true,
      },
      compression: {
        enabled: true,
        level: "balanced",
      },
    },
  };
}

/** Compatibility snapshot; use createPerformance() for isolated settings. */
export const defaultPerformance: PerformanceConfig = createPerformance();
