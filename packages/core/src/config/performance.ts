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

export const defaultPerformance: PerformanceConfig = {
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
