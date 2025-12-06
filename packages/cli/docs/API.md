# Blockingmachine CLI API Documentation

## Command Context

The base context available to all commands:

```typescript
interface CommandContext {
  config: AppConfig;
  debug: boolean;
  logger: Logger;
}
```

## Configuration Types

### App Configuration

```typescript
interface AppConfig {
  mongodb: MongoConfig;
  output: {
    directory: string;
  };
  baseDir: string;
  meta: Partial<FilterListMetadata>;
  sources: FilterSource[];
}

interface MongoConfig {
  uri: string;
  options: {
    maxPoolSize: number;
    [key: string]: any;
  };
}
```

### Filter List Configuration

```typescript
interface FilterListMetadata {
  title: string;
  description: string;
  homepage: string;
  version: string;
  lastUpdated: string;
}

interface FilterSource {
  name: string;
  url: string;
  category: CategoryName;
  enabled: boolean;
  priority?: number;
  tags?: string[];
  trusted?: boolean;
}
```

## Rule Processing

### Rule Types

```typescript
type RuleType = 
  | 'blocking'    // Basic blocking rules
  | 'unblocking'  // Exception rules (@@)
  | 'cosmetic'    // Element hiding rules (##)
  | 'scriptlet'   // Scriptlet injection
  | 'parameter'   // URL parameter rules
  | 'extended-css'// Extended CSS selectors
  | 'csp'        // Content Security Policy
  | 'redirect'   // Resource redirection
  | 'replace'    // Content replacement
  | 'html'       // HTML filtering
  | 'javascript' // JavaScript rules
```

### Rule Storage

```typescript
interface StoredRule {
  raw: string;
  type: RuleType;
  domain?: string;
  hash: string;
  metadata: RuleMetadata;
  variants?: RuleVariant[];
}

interface RuleMetadata {
  sources: string[];
  dateAdded: Date;
  lastUpdated: Date;
  enabled: boolean;
  sourceInfo: {
    category: CategoryName;
    trusted: boolean;
    url?: string;
  };
  tags: string[];
}

interface RuleVariant {
  rule: string;
  source: string;
  dateAdded: Date;
  modifiers: RuleModifier[];
  tags: string[];
}
```

## Export Options

```typescript
interface ExportOptions {
  formats?: SupportedFormat[];
  categories?: string[];
  excludeCategories?: string[];
  minPriority?: number;
  tags?: string[];
  outputPath?: string;
}

type SupportedFormat = 
  | 'hosts'
  | 'dnsmasq'
  | 'unbound'
  | 'bind'
  | 'privoxy'
  | 'shadowrocket'
  | 'adguard'
  | 'abp'
  | 'all';
```

## Command Results

```typescript
interface CommandResult {
  success: boolean;
  message?: string;
  data?: any;
  error?: Error;
}
```

## Performance Configuration

```typescript
interface PerformanceConfig {
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
      level: 'balanced' | 'aggressive' | 'conservative';
    };
  };
}
```

## Logger Interface

```typescript
interface Logger {
  debug(message: string, ...args: any[]): void;
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
}
```

## Events

The CLI emits the following events during operation:

```typescript
type CLIEvents = {
  'import:start': void;
  'import:progress': { processed: number; total: number };
  'import:complete': { stats: ImportStats };
  'export:start': void;
  'export:progress': { format: string; processed: number };
  'export:complete': { stats: ExportStats };
  'error': Error;
};
```

## Error Handling

```typescript
class CLIError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: any
  ) {
    super(message);
    this.name = 'CLIError';
  }
}
```

For usage examples, see [EXAMPLES.md](./EXAMPLES.md).
For configuration details, see [configuration.md](./guides/configuration.md).