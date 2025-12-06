# Blockingmachine CLI Examples

## Basic Usage

### Installation and Setup
```bash
# Install the CLI globally
npm install -g @blockingmachine/cli

# Initialize a new configuration
blockingmachine init

# Validate your configuration
blockingmachine validate
```

### Common Operations
```bash
# Import rules from all sources
blockingmachine import

# Export in AdGuard format
blockingmachine export adguard

# View database statistics
blockingmachine view
```

## Advanced Rule Processing

### Category-Based Filtering
```bash
# Export specific categories
blockingmachine export --categories privacy,security

# Export all except certain categories
blockingmachine export --exclude advertising,gaming

# Combine with format
blockingmachine export hosts --categories dns,security
```

### Priority-Based Filtering
```bash
# Export high-priority rules
blockingmachine export --min-priority 80

# Export medium-priority rules
blockingmachine export --min-priority 50 --categories advertising

# Export low-priority rules for testing
blockingmachine export --min-priority 30 --tags test
```

### Tag-Based Management
```bash
# Export mobile-specific rules
blockingmachine export --tags mobile

# Export trusted sources only
blockingmachine export --tags trusted

# Combine multiple tags
blockingmachine export --tags mobile,trusted,verified
```

## Export Formats

### DNS-Based Formats
```bash
# Export as hosts file
blockingmachine export hosts

# Export for dnsmasq
blockingmachine export dnsmasq

# Export for Unbound
blockingmachine export unbound

# Export for BIND
blockingmachine export bind
```

### Browser-Based Formats
```bash
# Export for AdGuard
blockingmachine export adguard

# Export as ABP format
blockingmachine export abp

# Export cosmetic filters only
blockingmachine export adguard --categories cosmetic
```

### Application-Specific Formats
```bash
# Export for Privoxy
blockingmachine export privoxy

# Export for Shadowrocket
blockingmachine export shadowrocket

# Export with custom output path
blockingmachine export privoxy --output ./custom/path/rules.action
```

## Database Management

### Viewing Data
```bash
# View basic statistics
blockingmachine view

# View with sample rules
blockingmachine view --sample 10

# Export detailed statistics
blockingmachine view --format json > stats.json
```

### Maintenance
```bash
# Run database migrations
blockingmachine migrate

# Clean up output directory
blockingmachine cleanup

# Development: Reset database
blockingmachine cleanup --drop
```

## Performance Optimization

### Batch Processing
```bash
# Set custom batch size
blockingmachine import --batch-size 1000

# Enable parallel processing
blockingmachine import --parallel 4

# Set processing timeout
blockingmachine import --timeout 30000
```

### Caching
```bash
# Enable caching
blockingmachine import --cache

# Clear cache
blockingmachine cleanup --cache

# Set custom cache size
blockingmachine import --cache-size 200mb
```

## Debugging

### Logging
```bash
# Enable debug logging
blockingmachine --debug import

# Save logs to file
blockingmachine import --log-file ./logs/import.log

# Show only errors
blockingmachine import --log-level error
```

### Validation
```bash
# Validate configuration
blockingmachine validate

# Validate and fix issues
blockingmachine validate --fix

# Test rule processing
blockingmachine validate --rules ./test-rules.txt
```

## Configuration Examples

### Custom Source Configuration
```json
{
  "sources": [
    {
      "name": "CustomList",
      "url": "https://example.com/rules.txt",
      "category": "custom",
      "enabled": true,
      "priority": 100,
      "tags": ["trusted", "verified"]
    }
  ]
}
```

### Performance Configuration
```json
{
  "performance": {
    "batchSize": 1000,
    "parallel": 4,
    "timeout": 30000,
    "caching": {
      "enabled": true,
      "ttl": 3600,
      "maxSize": "100mb"
    }
  }
}
```

For more detailed information, see:
- [API Documentation](./API.md)
- [Configuration Guide](./guides/configuration.md)
- [Rule Processing Guide](./guides/rule-processing.md)