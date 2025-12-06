# @blockingmachine/core

Core functionality for Blockingmachine, providing robust filter list processing and rule management for AdGuard Home and similar applications.

[![LICENSE: BSD-3-Clause](https://img.shields.io/badge/License-BSD_3--Clause-blue.svg)](https://opensource.org/licenses/BSD-3-Clause)
[![GitHub Actions](https://github.com/greigh/blockingmachine-cli/workflows/CI/badge.svg)](https://github.com/greigh/blockingmachine-cli/actions)
[![GitHub Release](https://img.shields.io/github/v/release/greigh/Blockingmachine-CLI)](https://github.com/greigh/Blockingmachine-core/releases)
[![NPM VERSION](https://badge.fury.io/js/@blockingmachine%2Fcore.svg)](https://www.npmjs.com/package/@blockingmachine/core)
[![NPM DOWNLOADS](https://img.shields.io/npm/dt/@blockingmachine/core)](https://www.npmjs.com/package/@blockingmachine/core)
[![CODE SIZE](https://img.shields.io/github/languages/code-size/greigh/blockingmachine-core)](https://github.com/greigh/blockingmachine-core)
[![COMMITS](https://img.shields.io/github/commit-activity/m/greigh/blockingmachine-core)](https://github.com/greigh/blockingmachine-core/graphs/commit-activity)

## Related Projects

- [Blockingmachine Desktop](https://github.com/greigh/Blockingmachine) - Desktop application
- [Blockingmachine CLI](https://github.com/greigh/Blockingmachine-cli) - Command line interface
- [Blockingmachine Database](https://github.com/greigh/Blockingmachine-database) - Filter list repository

## Features

- 🚀 Fast filter list processing
- 🔄 Rule deduplication
- 📥 Remote list fetching with retry logic
- ✨ Clean rule formatting
- 🛡️ AdGuard Home compatibility
- 💪 TypeScript support
- 🔁 Automatic retries for failed downloads
- 🎯 Efficient memory usage
- ⚡ Async processing support

## Installation

```bash
# Using npm
npm install @blockingmachine/core

# Using yarn
yarn add @blockingmachine/core

# Using pnpm
pnpm add @blockingmachine/core
```

## Quick Start

```typescript
import {
  RuleDeduplicator,
  parseFilterList,
  fetchContent,
} from "@blockingmachine/core";

// Basic usage
const rules = await parseFilterList("||example.com^");
const deduplicator = new RuleDeduplicator();
const uniqueRules = deduplicator.process(rules);

// Advanced usage with remote lists
async function processRemoteLists(urls: string[]) {
  const deduplicator = new RuleDeduplicator();
  let allRules: string[] = [];

  for (const url of urls) {
    const content = await fetchContent(url);
    if (content) {
      const rules = await parseFilterList(content);
      allRules = [...allRules, ...rules];
    }
  }

  return deduplicator.process(allRules);
}
```

## API Reference

### RuleDeduplicator

Process and deduplicate filtering rules.

```typescript
class RuleDeduplicator {
  constructor(options?: { caseSensitive?: boolean; keepComments?: boolean });

  process(rules: string[]): string[];
  addRule(rule: string): void;
  clear(): void;
}
```

#### Options

- `caseSensitive` (boolean, default: true): Preserve case when comparing rules
- `keepComments` (boolean, default: false): Retain comment lines in output

### parseFilterList(content: string, options?: ParseOptions): Promise<string[]>

Parse raw filter list content into individual rules.

```typescript
interface ParseOptions {
  skipComments?: boolean;
  skipEmpty?: boolean;
  trim?: boolean;
}

// Example usage
const rules = await parseFilterList("||example.com^\n||example.org^", {
  skipComments: true,
  skipEmpty: true,
  trim: true,
});
```

### fetchContent(url: string, options?: FetchOptions): Promise<string | null>

Fetch remote filter lists with built-in retry logic.

```typescript
interface FetchOptions {
  timeout?: number;
  retries?: number;
  retryDelay?: number;
}

// Example with options
const content = await fetchContent("https://example.com/filterlist.txt", {
  timeout: 5000, // 5 seconds
  retries: 3, // Try 3 times
  retryDelay: 1000, // Wait 1 second between retries
});
```

## Error Handling

```typescript
try {
  const content = await fetchContent("https://example.com/filterlist.txt");
  if (!content) {
    console.error("Failed to fetch content");
    return;
  }
  const rules = await parseFilterList(content);
} catch (error) {
  console.error("Error processing rules:", error);
}
```

## Best Practices

1. Memory Management

```typescript
// Process large lists in chunks
const deduplicator = new RuleDeduplicator();
for (const chunk of chunks) {
  const rules = await parseFilterList(chunk);
  deduplicator.process(rules);
}
```

2. Error Recovery

```typescript
// Implement retry logic for failed fetches
const content = await fetchContent(url, {
  retries: 5,
  retryDelay: 2000,
});
```

## Contributing

We welcome contributions! Please see our [contributing guidelines](CONTRIBUTING.md) for details.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the BSD 3-Clause License - see the [LICENSE](LICENSE) file for details.

### Summary of BSD 3-Clause License

You are free to:

- Use the software commercially
- Modify the software
- Distribute the software
- Place warranty on the software

Under the following conditions:

- License and copyright notice must be included with the software
- Neither the names of the copyright holder nor contributors may be used to promote derived products
- Source code must retain copyright notice, list of conditions, and disclaimer

[Read full license text](LICENSE)

## Related Projects

- [Blockingmachine Desktop](https://github.com/yourusername/Blockingmachine) - Desktop application
- [Blockingmachine CLI](https://github.com/yourusername/blockingmachine-cli) - Command line interface

## Support

- 📝 [Documentation](https://github.com/yourusername/Blockingmachine/wiki)
- 🐛 [Issue Tracker](https://github.com/yourusername/Blockingmachine/issues)
- 💬 [Discussions](https://github.com/yourusername/Blockingmachine/discussions)

## Acknowledgments

- AdGuard for their excellent filter syntax documentation
- All our contributors and users

## Advanced Usage

### Processing Multiple Filter Lists

```typescript
const sources = [
  "https://example.com/list1.txt",
  "https://example.com/list2.txt",
];

const processAllLists = async () => {
  const deduplicator = new RuleDeduplicator();
  const results = await Promise.allSettled(
    sources.map((url) => fetchContent(url)),
  );

  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      const rules = await parseFilterList(result.value);
      deduplicator.process(rules);
    }
  }
};
```

### Custom Rule Processing

```typescript
const customProcessor = async (content: string) => {
  const rules = await parseFilterList(content, {
    skipComments: true,
    skipEmpty: true,
    trim: true,
  });

  // Custom processing logic
  return rules.filter((rule) => {
    // Filter out rules containing specific patterns
    return !rule.includes("specific-pattern");
  });
};
```

## Performance Tips

### Memory Optimization

- Process large lists in chunks
- Clear the deduplicator cache periodically
- Use streaming for very large files

```typescript
const processLargeFile = async (filePath: string) => {
  const deduplicator = new RuleDeduplicator();
  const CHUNK_SIZE = 1000;
  let rules: string[] = [];

  // Read file in chunks
  for await (const chunk of readFileInChunks(filePath)) {
    const parsedRules = await parseFilterList(chunk);
    rules = [...rules, ...deduplicator.process(parsedRules)];

    if (rules.length > CHUNK_SIZE) {
      // Process chunk and clear cache
      await processRules(rules);
      deduplicator.clear();
      rules = [];
    }
  }
};
```

### Concurrent Processing

```typescript
const concurrentProcessing = async (urls: string[]) => {
  const BATCH_SIZE = 5; // Process 5 URLs at a time
  const results: string[] = [];

  for (let i = 0; i < urls.length; i += BATCH_SIZE) {
    const batch = urls.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map((url) => fetchContent(url)),
    );
    results.push(...batchResults.filter(Boolean));
  }

  return results;
};
```

## Debugging

Enable debug logging by setting the environment variable:

```bash
# macOS/Linux
export DEBUG=blockingmachine:*

# In your code
const debug = require('debug')('blockingmachine:core');
debug('Processing rules:', rules.length);
```

## Common Issues and Solutions

### Timeout Issues

```typescript
// Increase timeout for slow connections
const content = await fetchContent(url, {
  timeout: 10000, // 10 seconds
  retries: 5,
});
```

### Memory Issues

```typescript
// Use streaming API for large files
const deduplicator = new RuleDeduplicator({
  useStreaming: true,
  chunkSize: 1000,
});
```

### Rate Limiting

```typescript
// Add delays between requests
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchWithRateLimit = async (urls: string[]) => {
  for (const url of urls) {
    await fetchContent(url);
    await delay(1000); // Wait 1 second between requests
  }
};
```

## FAQ

### General Questions

**Q: What types of filter lists are supported?**
A: We support AdGuard-style filter lists, including:

- Domain-based rules (`||example.com^`)
- Basic pattern rules (`/ads/`)
- Comment lines (`! This is a comment`)
- AdGuard Home specific syntax

**Q: How large of a filter list can this handle?**
A: The library is optimized for large lists and can handle millions of rules when used with proper memory management practices (see Performance Tips section).

### Performance

**Q: Why is processing taking longer than expected?**
A: Several factors can affect processing speed:

- Large number of rules
- Complex pattern matching
- Network latency when fetching remote lists
- System memory constraints

Solution: Use the chunking and streaming options described in the Performance Tips section.

### Common Use Cases

**Q: How do I combine multiple filter lists?**

```typescript
const combineLists = async (urls: string[]) => {
  const deduplicator = new RuleDeduplicator();
  for (const url of urls) {
    const content = await fetchContent(url);
    if (content) {
      const rules = await parseFilterList(content);
      deduplicator.process(rules);
    }
  }
  return deduplicator.process([]);
};
```

**Q: How can I exclude certain domains from being blocked?**

```typescript
const excludeDomains = (rules: string[], excludeList: string[]) => {
  return rules.filter((rule) => {
    return !excludeList.some((domain) => rule.includes(domain));
  });
};
```

### Troubleshooting

**Q: Why am I getting timeout errors?**
A: Remote lists might be slow to respond. Try:

```typescript
const content = await fetchContent(url, {
  timeout: 30000, // 30 seconds
  retries: 5, // 5 attempts
  retryDelay: 2000, // 2 seconds between retries
});
```

**Q: How do I handle invalid rules?**
A: Use the parsing options to skip problematic rules:

```typescript
const rules = await parseFilterList(content, {
  skipInvalid: true,
  onError: (error, rule) => {
    console.warn(`Skipping invalid rule: ${rule}`);
  },
});
```

### Integration

**Q: Can I use this with Express.js?**
A: Yes, here's a basic example:

```typescript
import express from "express";
import { RuleDeduplicator, parseFilterList } from "@/core";

const app = express();

app.post("/process-rules", async (req, res) => {
  try {
    const rules = await parseFilterList(req.body.content);
    const deduplicator = new RuleDeduplicator();
    const processed = deduplicator.process(rules);
    res.json({ rules: processed });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
```

**Q: How do I save processed rules to a file?**
A: Use the built-in file system functions:

```typescript
import { promises as fs } from "fs";

const saveRules = async (rules: string[], filepath: string) => {
  await fs.writeFile(filepath, rules.join("\n"), "utf8");
};
```

### Updates and Maintenance

**Q: How often should I update my filter lists?**
A: Best practices suggest:

- Daily updates for actively maintained lists
- Weekly updates for stable lists
- Implement rate limiting when fetching multiple lists
- Use the `If-Modified-Since` header (supported by `fetchContent`)

**Q: How do I handle updates efficiently?**
A: Use the incremental update feature:

```typescript
const updateRules = async (existingRules: string[], newContent: string) => {
  const newRules = await parseFilterList(newContent);
  const deduplicator = new RuleDeduplicator();
  return deduplicator.process([...existingRules, ...newRules]);
};
```

## Timeline

### Current Release (v1.0.0-beta.3)

- 🎉 Initial public release
- 🚀 Core functionality implementation
- 💪 TypeScript support
- 📥 Remote list fetching
- 🔄 Rule deduplication
- ⚡ Async processing
- 🖥️ Works with Blockingmachine Desktop
- ✅ Improved compatibility with Blockingmachine CLI
- 🐞 Bug fixes and performance improvements

### Upcoming Features (v1.0.0)

- 📊 Rule statistics and analytics
- 🔍 Enhanced pattern matching
- 📋 Support for additional filter list formats
- 🌐 Better network resilience
- 🎯 Rule optimization algorithms
- 📦 Reduced bundle size
- 🧪 Extended test coverage

### Future Roadmap (v1.x+)

- 🔄 Streaming API for large files
- 🌍 Internationalization support
- 🔒 Enhanced security features
- 📈 Performance improvements
- 🧩 Plugin system
- 🤝 Third-party integrations
- 🛠️ Improved error handling

### Version History

#### 1.0.0-beta.3 (Current)

- Improved CLI compatibility
- Fixed several critical bugs
- Performance optimizations
- Documentation updates
- Added more comprehensive examples
- Fixed issues with NPM package integration

#### 1.0.0-beta.2

- Added support for additional filter formats
- Enhanced error handling
- Improved documentation
- Fixed dependency issues
- Fixed CLI integration bugs

#### 1.0.0-beta.1

- Initial public release
- Core functionality stable
- Basic documentation
- Essential features implemented

#### 0.9.0 (Internal)

- Feature complete
- Internal testing
- Performance optimization
- Documentation drafting

#### 0.5.0 (Development)

- Core architecture
- Basic feature implementation
- Initial testing setup
